// 함수형 코어. step(state, input, ctx) = apply(input) 다음 converge(state). 파일, 타이머, 프로세스, 시계가 없다.
// converge는 상태만 보고 할 일을 정하고(레벨 트리거), 낸 효과를 상태에 적어 두어 다시 돌려도 같은 효과를 두 번 내지 않는다.
// 그래서 재시작은 "state.json을 읽고 boot를 넣고 converge가 내는 효과를 실행"이 전부다.
import type { AgentKind, OfficeEvent, PlanItem, TaskResult } from '../../shared/protocol.ts';
import { NAMES, ROLES, cut } from '../../shared/activity.ts';
import { taskStatus } from '../../shared/tasks.ts';
import { type PlanSpec, validatePlan } from './dag.ts';
import {
  DEFAULT_LIMITS, LEAD, busy, moveTo, type Access, type Lead, type Limits, type Member, type Message, type MessageId, type MissionState, type Opaque, type Phase,
  type Question, type QuestionId, type RequestId, type Task, type TaskKey, type Who, type Worker, type WorkerId,
} from './model.ts';
import { answerText, briefText, followupText, parseHandback, resumeText, statusText, wakeText, withInbox } from './text.ts';

/** 어댑터가 CLI와 상관없는 모양으로 바꿔 넘기는 일꾼 신호. gen이 지금 gen과 다르면 버린다. */
export type Signal =
  | { k: 'session'; ref: Opaque }
  | { k: 'turn_started' }
  | { k: 'approval'; id: string; tool: string; label: string; detail: string; full: boolean }
  | { k: 'approval_cancelled'; id: string }
  | { k: 'turn_ended'; outcome: 'ok' | 'error' | 'interrupted'; text: string }
  | { k: 'exited'; why?: string }
  /** think, typing, say, act, act_done… 상태를 바꾸지 않고 그대로 내보낸다 */
  | { k: 'activity'; ev: OfficeEvent };

export type TimerEffect = { k: 'timer'; key: string; at: number; then: { k: 'wake' } | { k: 'kill'; who: Who; gen: number } };

export type Effect =
  | { k: 'provision'; key: string; worker: WorkerId; task: TaskKey; access: Access; upstream: TaskKey[] }
  | { k: 'open_session'; key: string; who: Who; gen: number; turn: string; resume?: Opaque }
  | { k: 'send_turn'; key: string; who: Who; gen: number; turn: string }
  | { k: 'answer_approval'; key: string; who: Who; gen: number; approvalId: string; allow: boolean }
  | { k: 'interrupt' | 'kill' | 'park'; key: string; who: Who; gen: number }
  | { k: 'checkpoint'; key: string; worker: WorkerId; message: string; task?: TaskKey }
  | { k: 'retire'; key: string; worker: WorkerId }
  | TimerEffect
  | { k: 'persist'; key: 'persist' };

export type Input =
  /** lost = 작업 폴더가 사라진 일꾼. 다음 일 때 작업 폴더를 다시 준비한다(브랜치는 그대로 다시 붙는다) */
  | { k: 'boot'; lost?: readonly string[] }
  | { k: 'tick' }
  /** 셸이 git으로 알아낸 끝난 할 일의 브랜치 정보(보관 뒤의 비교, 합치기, 버리기). note는 그 일꾼 카드에 남는다 */
  | { k: 'task_result'; task: string; patch: Partial<TaskResult>; note?: string }
  /** 사용자가 쉬는 일꾼을 내보낸다(브랜치를 버리기 전에 작업 폴더를 정리한다) */
  | { k: 'user_retire'; who: string }
  | { k: 'user_said'; to: string; text: string; replyTo?: string }
  | { k: 'user_replied'; questionId: string; text: string }
  | { k: 'user_approved'; requestId: string; allow: boolean }
  | { k: 'user_stop'; who?: string }
  | { k: 'user_resume' }
  | { k: 'lead_plan'; specs: readonly PlanSpec[] }
  | { k: 'lead_message'; to: string; text: string; replyTo?: string; requestId?: string }
  | { k: 'lead_cancel'; target: { task: string } | { worker: string } }
  | { k: 'lead_status' }
  /** 미션을 놓아준다(새 미션, 새 미션 버튼, 서버 종료): 모두 내보내고 end를 낸다 */
  | { k: 'release' }
  | { k: 'signal'; who: string; gen: number; sig: Signal }
  | { k: 'effect_ok'; effect: Effect; out?: Opaque }
  /** conflict = provision이 앞 할 일의 브랜치끼리 합쳐지지 않아서 실패했다는 뜻이다(브랜치 이름들). 잠깐 실패가 아니라 재시도해도 같다 */
  | { k: 'effect_failed'; effect: Effect; why: string; conflict?: readonly string[] }
  | { k: 'timer_fired'; timer: TimerEffect };

export type Reply = { ok: true; text?: string } | { ok: false; error: string };

export interface StepCtx {
  now: number;
  installed: readonly AgentKind[];
  /** 일꾼 id 끝에 붙일 짧은 무작위 글자(`[a-z0-9]{4}`). 셸이 만들고, 테스트는 고정값을 넣는다 */
  salt: string;
}

export interface StepResult { state: MissionState; events: OfficeEvent[]; effects: Effect[]; reply: Reply }

interface Draft { s: MissionState; ev: OfficeEvent[]; fx: Effect[]; ctx: StepCtx }

/** apply가 이걸 돌려주면 입력이 상태를 바꾸지 않은 것이다(거절, 오래된 신호, 중복 요청, 읽기). converge는 그래도 돈다. */
type Same = { same: Reply };

const SEAT_TAKEN = '사용자가 멈춘 일꾼이에요. 사용자가 다시 시킬 때까지 기다려 주세요.';

export function step(state: MissionState, input: Input, ctx: StepCtx): StepResult {
  if (input.k === 'signal' && input.sig.k === 'activity') {
    const w = workerOf(state, input.who);
    const fresh = w !== undefined && w.gen === input.gen;
    return { state, events: fresh ? [input.sig.ev] : [], effects: [], reply: fresh ? { ok: true } : { ok: false, error: '오래된 신호예요.' } };
  }
  const d: Draft = { s: structuredClone(state), ev: [], fx: [], ctx };
  const r = apply(d, input);
  if ('same' in r) return converge(state, ctx, r.same);
  return finish(d, state, r);
}

/** 미션은 첫 요청과 함께 태어나고 바로 일한다. 상태가 없는 미션은 없다. */
export function createMission(opening: string, ctx: StepCtx, limits: Limits = DEFAULT_LIMITS): StepResult {
  const s: MissionState = {
    v: 1, status: 'working', seq: 0, tasks: {}, workers: {}, questions: {}, news: [], wakeAt: null, leadLast: '', requests: [], limits,
    lead: { kind: 'lead', id: LEAD, agent: 'claude', gen: 0, residency: 'parked', inbox: [], startFailures: 0, turns: 0, phase: { k: 'idle' } },
  };
  const d: Draft = { s, ev: [], fx: [], ctx };
  s.lead.inbox.push({ id: mint(d, 'm') as MessageId, from: 'user', kind: 'followup', text: opening });
  d.ev.push({ k: 'start', text: opening });
  return finish(d, null, { ok: true });
}

/** 입력 없이 converge만. 같은 상태에 두 번 돌려도 두 번째는 아무것도 내지 않는다. */
export function converge(state: MissionState, ctx: StepCtx, reply: Reply = { ok: true }): StepResult {
  const d: Draft = { s: structuredClone(state), ev: [], fx: [], ctx };
  return finish(d, state, reply);
}

/** 바뀐 것이 없으면 받은 상태 객체를 그대로 돌려준다(거절, 오래된 신호, 중복 요청을 호출자가 알아볼 수 있게). */
function finish(d: Draft, before: MissionState | null, reply: Reply): StepResult {
  reconcile(d);
  if (d.ev.some((e) => e.k === 'task')) d.ev.push({ k: 'plan', items: planItems(d.s) });
  const changed = before === null || JSON.stringify(d.s) !== JSON.stringify(before);
  if (changed) d.fx.push({ k: 'persist', key: 'persist' });
  return { state: changed || !before ? d.s : before, events: d.ev, effects: d.fx, reply };
}

// ── apply ─────────────────────────────────────────────────────────────────────

function apply(d: Draft, input: Input): Reply | Same {
  const { s } = d;
  switch (input.k) {
    case 'boot': return boot(d, input.lost ?? []);
    case 'tick': return { ok: true };
    case 'task_result': {
      const t = s.tasks[input.task];
      if (!t) return { same: { ok: false, error: `할 일 '${input.task}'는 없어요.` } };
      const before = JSON.stringify(t.run);
      if (t.run.k === 'done') t.run = { k: 'done', result: { ...t.run.result, ...input.patch } };
      const w = t.seat ? s.workers[t.seat] : undefined;
      if (input.note && w) d.ev.push(workerEv(w, input.note));
      if (JSON.stringify(t.run) !== before) d.ev.push(taskEv(t));
      else if (!input.note || !w) return { same: { ok: true } };
      return { ok: true };
    }
    case 'user_retire': {
      const w = s.workers[input.who];
      if (!w) return { same: { ok: false, error: '그런 일꾼은 없어요.' } };
      if (w.phase.k === 'retired') return { same: { ok: true } };
      if (!['idle', 'stopped', 'failed'].includes(w.phase.k)) return { same: { ok: false, error: `${w.name}가 아직 일하는 중이에요. 멈춘 뒤에 해 주세요.` } };
      land(d, w, 'retired');
      return { ok: true };
    }
    case 'user_said': {
      if (input.to === LEAD) {
        wake(d);
        if (s.lead.phase.k === 'stopped') revive(d, s.lead);
        s.lead.inbox.push({ id: mint(d, 'm') as MessageId, from: 'user', kind: 'followup', text: input.text });
        d.ev.push({ k: 'start', text: input.text });
        return { ok: true };
      }
      const m = s.workers[input.to];
      if (!m) return { same: { ok: false, error: '그런 일꾼은 없어요.' } };
      return deliverOrSame(d, 'user', m, input.text, input.replyTo);
    }
    case 'user_replied': {
      const q = s.questions[input.questionId];
      if (!q) return { same: { ok: false, error: '그런 질문은 없어요.' } };
      return deliverOrSame(d, 'user', s.workers[q.from], input.text, q.id);
    }
    case 'user_approved': {
      const w = allWorkers(s).find((x) => x.phase.k === 'blocked' && x.phase.on.reason === 'approval' && x.phase.on.requestId === input.requestId);
      if (!w || w.phase.k !== 'blocked' || w.phase.on.reason !== 'approval') return { same: { ok: false, error: '이미 끝난 요청이에요.' } };
      const { approvalId } = w.phase.on;
      d.fx.push({ k: 'answer_approval', key: `answer:${w.id}:${approvalId}`, who: w.id, gen: w.gen, approvalId, allow: input.allow });
      setPhase(d, w, { k: 'working' });
      d.ev.push({ k: 'ask_done', requestId: input.requestId, allow: input.allow });
      return { ok: true };
    }
    case 'user_stop': {
      if (input.who === undefined) {
        if (s.status === 'working') s.status = 'stopped';
        haltAll(d);
        return { ok: true };
      }
      const w = workerOf(s, input.who);
      if (!w) return { same: { ok: false, error: '그런 일꾼은 없어요.' } };
      const before = w.phase.k;
      stop(d, w, 'stopped');
      if (w.phase.k === before) return { same: { ok: true } };
      if (w.kind === 'member') news(d, `사용자가 ${label(w)}를 멈췄어요.`);
      return { ok: true };
    }
    case 'user_resume': {
      wake(d);
      for (const w of allWorkers(s)) if (w.phase.k === 'stopped') revive(d, w);
      return { ok: true };
    }
    case 'lead_plan': {
      const r = validatePlan(s, input.specs, d.ctx.installed);
      if (!r.ok) return { same: { ok: false, error: r.errors.join('\n') } };
      for (const spec of r.specs) {
        const old = s.tasks[spec.key];
        const t: Task = { ...spec, n: old?.n ?? ++s.seq, origin: 'plan', run: { k: 'pending' }, turns: 0 };
        s.tasks[t.key] = t;
        d.ev.push(taskEv(t));
      }
      return { ok: true, text: `할 일 ${input.specs.length}개를 받았어요. 이제 턴을 끝내세요. 일이 끝나거나 질문이 오면 사무실이 알려 줄게요.` };
    }
    case 'lead_message': {
      if (input.requestId !== undefined && s.requests.includes(input.requestId)) return { same: { ok: true, text: '이미 받은 메시지예요.' } };
      const m = s.workers[input.to];
      if (!m) return { same: { ok: false, error: `일꾼 '${input.to}'는 없어요. office_status로 일꾼 id를 확인해 주세요.` } };
      const r = deliverOrSame(d, LEAD, m, input.text, input.replyTo);
      if (!('same' in r) && input.requestId !== undefined) s.requests = [...s.requests, input.requestId].slice(-200);
      return r;
    }
    case 'lead_cancel': return 'task' in input.target ? cancelTask(d, input.target.task) : cancelWorker(d, input.target.worker);
    case 'lead_status': return { same: { ok: true, text: statusText(s) } };
    case 'release': return release(d);
    case 'signal': {
      const w = workerOf(s, input.who);
      if (!w || w.gen !== input.gen) return { same: { ok: false, error: '오래된 신호예요.' } };
      return signal(d, w, input.sig);
    }
    case 'effect_ok': return effectOk(d, input.effect, input.out);
    case 'effect_failed': return effectFailed(d, input.effect, input.why, input.conflict);
    case 'timer_fired': {
      const { then } = input.timer;
      if (then.k === 'wake') {
        // 노드의 타이머는 Date.now()보다 1ms쯤 일찍 깨어날 수 있다. 타이머는 한 번뿐이라, 그때 아직 안 됐다고 보면 다시 깨우는 이가 없다.
        if (s.wakeAt !== null && s.wakeAt <= input.timer.at) s.wakeAt = Math.min(s.wakeAt, d.ctx.now);
        return { ok: true };
      }
      const w = workerOf(s, then.who);
      if (!w || w.gen !== then.gen || w.phase.k !== 'stopping' || w.phase.killed) return { same: { ok: true } };
      w.phase = { ...w.phase, killed: true };
      d.fx.push({ k: 'kill', key: `kill:${w.id}:${w.gen}`, who: w.id, gen: w.gen });
      return { ok: true };
    }
  }
}

/** 서버가 다시 켜짐: 돌던 것은 모두 내려놓고 미션은 멈춘다. 저절로 다시 시작하지 않는다. */
function boot(d: Draft, lost: readonly string[]): Reply {
  const { s } = d;
  const note = '서버가 다시 켜져서 멈췄어요.';
  if (s.status === 'working') s.status = 'stopped';
  s.wakeAt = null;
  for (const id of lost) if (s.workers[id]) s.workers[id].workspace = undefined;
  for (const w of allWorkers(s)) {
    w.residency = 'parked';
    w.gen++;
    const p = w.phase;
    if (p.k === 'stopping') { land(d, w, p.then); continue; }
    if (p.k === 'blocked' && p.on.reason === 'question') continue;
    if (!busy(p)) continue;
    if (p.k === 'blocked' && p.on.reason === 'approval') d.ev.push({ k: 'ask_done', requestId: p.on.requestId, allow: false, cancelled: true });
    if (w.kind === 'member') {
      const t = taskOf(s, w.id);
      if (t) {
        if (p.k === 'provisioning' || p.k === 'starting') t.carry = p.turn;
        setRun(d, t, { k: 'pending' });
      }
      d.fx.push({ k: 'checkpoint', key: `checkpoint:${w.id}:${w.turns}:boot`, worker: w.id, message: '사무실: 중단된 작업 보관', ...(t ? { task: t.key } : {}) });
    }
    setPhase(d, w, { k: 'idle' }, note);
  }
  return { ok: true };
}

/** 놓아주기: 프로세스를 모두 끝내고, 일꾼은 떠나고(leave), 열린 요청은 닫고, end를 낸다. 할 일은 기록에 그대로 남는다. */
function release(d: Draft): Reply {
  const { s } = d;
  for (const w of allWorkers(s)) {
    if (w.residency === 'live') {
      d.fx.push({ k: 'kill', key: `kill:${w.id}:${w.gen}:release`, who: w.id, gen: w.gen });
      w.residency = 'parked';
    }
    const p = w.phase;
    if (p.k === 'blocked' && p.on.reason === 'approval') d.ev.push({ k: 'ask_done', requestId: p.on.requestId, allow: false, cancelled: true });
    if (p.k === 'blocked' && p.on.reason === 'question') {
      const q = s.questions[p.on.question];
      if (q.state.k === 'open') {
        q.state = { k: 'void' };
        if (q.audience === 'user') d.ev.push({ k: 'ask_done', requestId: q.id, allow: false, cancelled: true });
      }
    }
    if (p.k === 'working') setPhase(d, w, { k: 'stopping', then: 'retired', killed: true });
    if (w.kind === 'member' && w.phase.k !== 'retired') land(d, w, 'retired');
    if (w.kind === 'lead' && w.phase.k !== 'idle' && w.phase.k !== 'stopped' && w.phase.k !== 'failed') land(d, w, 'stopped');
  }
  for (const q of Object.values(s.questions)) if (q.state.k === 'open') q.state = { k: 'void' };
  s.news = [];
  s.wakeAt = null;
  if (s.status === 'working') s.status = 'stopped';
  d.ev.push({ k: 'end', ok: s.status === 'done', text: s.leadLast, ms: 0, ...(s.status === 'done' ? {} : { stopped: true }) });
  return { ok: true };
}

function wake(d: Draft) {
  if (d.s.status !== 'working') d.s.status = 'working';
  // 맥스를 시작하지 못해 멈춘 미션은 다시 시작할 때 맥스부터 다시 시도한다
  if (d.s.lead.phase.k === 'failed') revive(d, d.s.lead);
}

/** 모두 멈춘다: 일꾼은 멈춘 자리에 서고, 맥스도 쉰다. */
function haltAll(d: Draft) {
  for (const m of Object.values(d.s.workers)) stop(d, m, 'stopped');
  stop(d, d.s.lead, 'stopped');
}

function revive(d: Draft, w: Worker) {
  w.startFailures = 0;
  setPhase(d, w, { k: 'idle' });
}

/** 사용자나 맥스가 일꾼에게 하는 말 하나의 길: 열린 질문의 답, 이미 답한 질문의 메모, 아니면 편지함. */
function deliverOrSame(d: Draft, from: 'user' | typeof LEAD, m: Member, text: string, replyTo?: string): Reply | Same {
  const { s } = d;
  if (m.phase.k === 'retired') return { same: { ok: false, error: `${label(m)}는 이미 사무실을 떠났어요.` } };
  let q: Question | undefined;
  if (replyTo !== undefined) {
    q = s.questions[replyTo];
    if (!q || q.from !== m.id) return { same: { ok: false, error: `${replyTo}는 ${label(m)}의 질문이 아니에요.` } };
  } else if (m.phase.k === 'blocked' && m.phase.on.reason === 'question') q = s.questions[m.phase.on.question];
  if (from === 'user') wake(d);
  if (q?.state.k === 'open') {
    q.state = { k: 'answered', by: from, text };
    d.ev.push({ k: 'msg', id: mint(d, 'm'), from, to: m.id, kind: 'answer', text, replyTo: q.id });
    if (q.audience === 'user') d.ev.push({ k: 'ask_done', requestId: q.id, allow: true });
    return { ok: true, text: '답을 전했어요.' };
  }
  if (q?.state.k === 'answered') {
    m.inbox.push({ id: mint(d, 'm') as MessageId, from, kind: 'note', text });
    d.ev.push({ k: 'msg', id: m.inbox.at(-1)!.id, from, to: m.id, kind: 'note', text, replyTo: q.id });
    return { ok: true, text: `${q.state.by === 'user' ? '사용자' : '맥스'}가 먼저 답했어요. 이 말은 메모로 전할게요.` };
  }
  if (m.phase.k === 'stopped') {
    if (from === LEAD) return { same: { ok: false, error: SEAT_TAKEN } };
    revive(d, m);
  }
  if (m.phase.k === 'failed') revive(d, m);
  const msg: Message = { id: mint(d, 'm') as MessageId, from, kind: 'followup', text };
  m.inbox.push(msg);
  d.ev.push({ k: 'msg', id: msg.id, from, to: m.id, kind: 'followup', text });
  return { ok: true, text: '전했어요. 지금 턴이 끝나면 받아요.' };
}

function cancelTask(d: Draft, key: string): Reply | Same {
  const t = d.s.tasks[key];
  if (!t) return { same: { ok: false, error: `할 일 '${key}'는 없어요.` } };
  if (t.run.k !== 'pending' && t.run.k !== 'running') return { same: { ok: false, error: `할 일 '${key}'는 이미 끝났어요.` } };
  const w = t.run.k === 'running' ? d.s.workers[t.run.worker] : undefined;
  setRun(d, t, { k: 'cancelled' });
  t.carry = undefined;
  if (w) stop(d, w, 'idle');
  return { ok: true, text: `할 일 '${key}'를 취소했어요.` };
}

function cancelWorker(d: Draft, id: string): Reply | Same {
  const w = d.s.workers[id];
  if (!w || w.phase.k === 'retired') return { same: { ok: false, error: `일꾼 '${id}'는 없거나 이미 떠났어요.` } };
  const t = taskOf(d.s, w.id);
  if (t) setRun(d, t, { k: 'cancelled' });
  stop(d, w, 'retired');
  return { ok: true, text: `${label(w)}를 내보내요.` };
}

/** 멈춤 하나의 길: 턴이 돌고 있으면 interrupt하고 stopping에서 기다리고, 아니면 바로 내려앉는다. */
function stop(d: Draft, w: Worker, then: 'idle' | 'stopped' | 'retired') {
  const p = w.phase;
  if (p.k === 'retired') return;
  if (p.k === 'stopping') {
    if (then === 'retired') w.phase = { ...p, then };
    return;
  }
  if ((p.k === 'provisioning' || p.k === 'starting') && !p.sent) {
    if (w.kind === 'member') carry(d, w, p.turn);
    land(d, w, then);
    return;
  }
  if (p.k === 'idle' || p.k === 'stopped' || p.k === 'failed' || p.k === 'provisioning') {
    if (p.k === 'provisioning' && w.kind === 'member') carry(d, w, p.turn);
    if (then === 'retired' || p.k === 'provisioning') land(d, w, then);
    return;
  }
  if (p.k === 'blocked' && p.on.reason === 'question') {
    const q = d.s.questions[p.on.question];
    if (q.state.k === 'open') {
      q.state = { k: 'void' };
      if (q.audience === 'user') d.ev.push({ k: 'ask_done', requestId: q.id, allow: false, cancelled: true });
    }
    land(d, w, then);
    return;
  }
  if (p.k === 'blocked' && p.on.reason === 'approval') d.ev.push({ k: 'ask_done', requestId: p.on.requestId, allow: false, cancelled: true });
  if (p.k === 'starting' && w.kind === 'member') carry(d, w, p.turn);
  setPhase(d, w, { k: 'stopping', then, killed: false });
  d.fx.push({ k: 'interrupt', key: `interrupt:${w.id}:${w.gen}`, who: w.id, gen: w.gen });
  d.fx.push({ k: 'timer', key: `timer:kill:${w.id}:${w.gen}`, at: d.ctx.now + d.s.limits.stopGraceMs, then: { k: 'kill', who: w.id, gen: w.gen } });
}

function carry(d: Draft, m: Member, turn: string) {
  const t = taskOf(d.s, m.id);
  if (t) t.carry = turn;
}

/** 멈춘 뒤 내려앉기. 아직 돌던 할 일은 같은 자리에서 다시 하도록 pending으로 돌아간다. */
function land(d: Draft, w: Worker, then: 'idle' | 'stopped' | 'retired') {
  if (w.kind === 'lead') {
    setPhase(d, w, { k: then === 'retired' ? 'stopped' : then });
    return;
  }
  const t = taskOf(d.s, w.id);
  if (t) setRun(d, t, { k: 'pending' });
  setPhase(d, w, { k: then });
  if (then !== 'retired') return;
  w.residency = 'parked';
  d.fx.push({ k: 'retire', key: `retire:${w.id}`, worker: w.id });
  d.ev.push({ k: 'leave', who: w.id, ok: true, tokens: 0, tools: 0, ms: 0 });
  for (const x of Object.values(d.s.tasks)) {
    if (x.run.k !== 'pending') continue;
    if (x.pin === w.id) setRun(d, x, { k: 'cancelled' });
    else if (x.seat === w.id) x.seat = undefined;
  }
}

function signal(d: Draft, w: Worker, sig: Signal): Reply | Same {
  const p = w.phase;
  switch (sig.k) {
    case 'activity': return { ok: true };
    case 'session': w.session = sig.ref; return { ok: true };
    case 'turn_started':
      if (p.k !== 'starting') return { same: { ok: true } };
      turnStarted(d, w);
      return { ok: true };
    case 'approval': {
      if (p.k === 'starting') turnStarted(d, w);
      if (w.phase.k !== 'working') return { same: { ok: true } };
      const requestId = mint(d, 'a') as RequestId;
      setPhase(d, w, { k: 'blocked', on: { reason: 'approval', requestId, approvalId: sig.id } });
      d.ev.push({ k: 'ask', who: w.id, requestId, tool: sig.tool, label: sig.label, detail: sig.detail, full: sig.full, kind: 'approval' });
      return { ok: true };
    }
    case 'approval_cancelled':
      if (p.k !== 'blocked' || p.on.reason !== 'approval' || p.on.approvalId !== sig.id) return { same: { ok: true } };
      d.ev.push({ k: 'ask_done', requestId: p.on.requestId, allow: false, cancelled: true });
      setPhase(d, w, { k: 'working' });
      return { ok: true };
    case 'turn_ended': return turnEnded(d, w, sig.outcome, sig.text);
    case 'exited': {
      w.residency = 'parked';
      if ((p.k === 'starting' && p.sent)) startFailed(d, w, sig.why ?? '프로그램이 턴을 시작하기 전에 끝났어요.');
      else if (p.k === 'working' || (p.k === 'blocked' && p.on.reason === 'approval')) turnEnded(d, w, 'error', sig.why ?? '프로그램이 갑자기 끝났어요.');
      else if (p.k === 'stopping') land(d, w, p.then);
      return { ok: true };
    }
  }
}

function turnStarted(d: Draft, w: Worker) {
  w.startFailures = 0;
  w.turns++;
  if (w.kind === 'member') {
    const t = taskOf(d.s, w.id);
    if (t) { t.turns++; t.carry = undefined; }
  }
  setPhase(d, w, { k: 'working' });
}

function turnEnded(d: Draft, w: Worker, outcome: 'ok' | 'error' | 'interrupted', text: string): Reply | Same {
  const { s } = d;
  if (w.phase.k === 'starting') turnStarted(d, w);
  const p = w.phase;
  if (p.k === 'stopping') { land(d, w, p.then); return { ok: true }; }
  if (p.k === 'blocked' && p.on.reason === 'approval') {
    d.ev.push({ k: 'ask_done', requestId: p.on.requestId, allow: false, cancelled: true });
    setPhase(d, w, { k: 'working' });
  }
  if (w.phase.k !== 'working') return { same: { ok: true } };

  if (w.kind === 'lead') {
    if (outcome === 'ok' && text.trim()) s.leadLast = text.trim();
    setPhase(d, w, { k: 'idle' }, outcome === 'ok' ? undefined : '맥스의 턴이 오류로 끝났어요.');
    for (const q of Object.values(s.questions)) if (q.state.k === 'open' && q.audience === 'lead' && q.told) escalate(d, q);
    return { ok: true };
  }

  const t = taskOf(s, w.id);
  d.fx.push({ k: 'checkpoint', key: `checkpoint:${w.id}:${w.turns}`, worker: w.id, message: t ? `${t.key}: ${t.title}` : w.name, ...(t ? { task: t.key } : {}) });
  if (!t) { setPhase(d, w, { k: 'idle' }); return { ok: true }; }
  if (outcome !== 'ok') {
    const why = cut(text, 300) || '턴이 오류로 끝났어요.';
    setRun(d, t, { k: 'failed', why, attempts: 1 });
    setPhase(d, w, { k: 'idle' }, why);
    news(d, `${label(w)}가 할 일 '${t.key}'에서 실패했어요.${blockedNote(s, t.key)}`, why);
    return { ok: true };
  }
  const { handback: hb, text: shown } = parseHandback(text);
  if (hb.status === 'done') {
    setRun(d, t, { k: 'done', result: { summary: hb.summary } });
    d.ev.push({ k: 'report', who: w.id, text: shown || hb.summary });
    setPhase(d, w, { k: 'idle' });
    news(d, `${label(w)}가 할 일 '${t.key}'를 마쳤어요.`, hb.summary);
    return { ok: true };
  }
  const asked = hb.status === 'question' ? hb.question : hb.why;
  const q: Question = {
    id: mint(d, 'q') as QuestionId, from: w.id, task: t.key, text: asked, audience: hb.status === 'question' ? hb.audience : 'lead',
    told: false, state: { k: 'open' }, ...(hb.status === 'question' && hb.options ? { options: hb.options } : {}),
  };
  s.questions[q.id] = q;
  setPhase(d, w, { k: 'blocked', on: { reason: 'question', question: q.id } });
  d.ev.push({ k: 'msg', id: mint(d, 'm'), from: w.id, to: q.audience === 'user' ? 'user' : LEAD, kind: 'question', text: asked });
  if (q.audience === 'user') askUser(d, q);
  else s.news.push({ id: mint(d, 'n'), line: `${label(w)}가 할 일 '${t.key}'에서 질문했어요(${q.id}). office_message로 답해 주세요.`, data: asked, question: q.id });
  return { ok: true };
}

function escalate(d: Draft, q: Question) {
  q.audience = 'user';
  askUser(d, q);
}

function askUser(d: Draft, q: Question) {
  d.ev.push({ k: 'ask', who: q.from, requestId: q.id, tool: '', label: cut(q.text, 80), detail: q.text, full: true, kind: 'question', ...(q.options ? { options: q.options } : {}) });
}

function startFailed(d: Draft, w: Worker, why: string) {
  const p = w.phase;
  if (p.k !== 'provisioning' && p.k !== 'starting') return;
  w.startFailures++;
  w.residency = 'parked';
  if (w.startFailures < d.s.limits.startFailureLimit) { w.phase = { ...p, sent: false }; return; }
  const note = cut(why, 300);
  if (w.kind === 'lead') {
    // 맥스 없이는 아무도 마무리하지 못한다. 미션을 오류로 세우고 일꾼을 멈춘 채로 둔다. 사용자가 이어서 하면 이 턴부터 다시 시도한다
    w.retry = p.turn;
    d.s.status = 'error';
    d.s.news = [];
    d.s.wakeAt = null;
    setPhase(d, w, { k: 'failed' }, note);
    d.ev.push({ k: 'error', message: `맥스를 시작하지 못했어요. ${note || '이유를 알 수 없어요.'} 다시 하려면 “이어서 하기”를 눌러 주세요.` });
    for (const m of Object.values(d.s.workers)) stop(d, m, 'stopped');
    return;
  }
  const t = taskOf(d.s, w.id);
  if (t) setRun(d, t, { k: 'failed', why: note, attempts: w.startFailures });
  setPhase(d, w, { k: 'failed' }, note);
  news(d, `${label(w)}가 ${w.startFailures}번 연달아 시작하지 못해서 할 일 '${t?.key}'를 실패로 표시했어요.${t ? blockedNote(d.s, t.key) : ''}`, note);
}

/** 앞 할 일의 브랜치끼리 합쳐지지 않는다: 다시 해 봐야 같으므로 재시도 없이 바로 서고, 맥스가 계획을 고치도록 소식 한 번을 남긴다. */
function startBlocked(d: Draft, w: Member, branches: readonly string[]) {
  w.residency = 'parked';
  const why = cut(`앞 할 일의 브랜치끼리 충돌해요: ${branches.join(', ')}`, 300);
  const t = taskOf(d.s, w.id);
  if (t) setRun(d, t, { k: 'failed', why, attempts: 1 });
  setPhase(d, w, { k: 'failed' }, why);
  news(d, `${label(w)}가 할 일 '${t?.key}'를 시작하지 못했어요. ${why} 다시 해 봐도 같아서 멈췄어요.${t ? blockedNote(d.s, t.key) : ''}`, why);
}

function effectOk(d: Draft, e: Effect, out?: Opaque): Reply | Same {
  if (e.k === 'provision') {
    const m = d.s.workers[e.worker];
    if (!m) return { same: { ok: true } };
    m.workspace = out;
    if (m.phase.k === 'provisioning' && m.phase.sent) setPhase(d, m, { k: 'starting', turn: m.phase.turn, sent: false });
    return { ok: true };
  }
  if (e.k === 'open_session') {
    const w = workerOf(d.s, e.who);
    if (!w || w.gen !== e.gen || w.residency === 'live') return { same: { ok: true } };
    w.residency = 'live';
    return { ok: true };
  }
  return { same: { ok: true } };
}

function effectFailed(d: Draft, e: Effect, why: string, conflict?: readonly string[]): Reply | Same {
  if (e.k === 'provision') {
    const m = d.s.workers[e.worker];
    if (!m || m.phase.k !== 'provisioning' || !m.phase.sent) return { same: { ok: true } };
    if (conflict?.length) startBlocked(d, m, conflict);
    else startFailed(d, m, why);
    return { ok: true };
  }
  if (e.k === 'open_session' || e.k === 'send_turn') {
    const w = workerOf(d.s, e.who);
    if (!w || w.gen !== e.gen) return { same: { ok: true } };
    if (w.phase.k === 'stopping') { w.residency = 'parked'; land(d, w, w.phase.then); return { ok: true }; }
    if (w.phase.k !== 'starting' || !w.phase.sent) return { same: { ok: true } };
    startFailed(d, w, why);
    return { ok: true };
  }
  if (e.k === 'checkpoint') {
    d.ev.push({ k: 'worker', id: e.worker, phase: d.s.workers[e.worker]?.phase.k ?? 'idle', note: `작업을 보관하지 못했어요: ${cut(why, 200)}` });
    return { same: { ok: true } };
  }
  return { same: { ok: true } };
}

// ── converge ─────────────────────────────────────────────────────────────────

function reconcile(d: Draft) {
  const { s } = d;
  if (s.status === 'working') {
    followups(d);
    assign(d);
    answers(d);
    leadWake(d);
  }
  for (const w of allWorkers(s)) emitTurn(d, w);
  settle(d);
  park(d);
}

/** 끝난 일꾼에게 온 말은 그 일꾼에게 묶인 새 할 일이 된다. 그래서 모든 턴은 할 일 하나에 속한다. */
function followups(d: Draft) {
  const { s } = d;
  for (const m of Object.values(s.workers)) {
    if (m.phase.k !== 'idle' || !m.inbox.length) continue;
    if (Object.values(s.tasks).some((t) => t.run.k === 'pending' && (t.pin ?? t.seat) === m.id)) continue;
    const { title, brief } = followupText(m.inbox);
    m.inbox = [];
    const n = ++s.seq;
    const t: Task = {
      key: `f.${n}` as TaskKey, title, brief, role: m.role, agent: m.agent, access: m.access, after: [], pin: m.id,
      n, origin: 'followup', run: { k: 'pending' }, turns: 0,
    };
    s.tasks[t.key] = t;
    d.ev.push(taskEv(t));
  }
}

function assign(d: Draft) {
  const { s } = d;
  let live = Object.values(s.workers).filter((m) => busy(m.phase)).length;
  const ready = Object.values(s.tasks).filter((t) => t.run.k === 'pending' && taskStatus(s.tasks, t.key) === 'ready').sort((a, b) => a.n - b.n);
  for (const t of ready) {
    if (live >= s.limits.maxLive) break;
    const seat = t.pin ?? t.seat;
    let m: Member | undefined;
    if (seat) {
      m = s.workers[seat];
      if (!m || m.phase.k !== 'idle') continue;
    } else {
      if (Object.values(s.workers).filter((w) => w.phase.k !== 'retired').length >= s.limits.maxWorkers && !retireOne(d)) continue;
      m = hire(d, t);
    }
    startTask(d, m, t);
    live++;
  }
}

/** 일꾼 수가 꽉 찼을 때, 남은 일이 없는 가장 오래된 쉬는 일꾼을 내보내 자리를 만든다(브랜치는 남는다). */
function retireOne(d: Draft): boolean {
  const { s } = d;
  const held = new Set(Object.values(s.tasks).flatMap((t) => (t.run.k === 'pending' ? [t.pin ?? t.seat] : [])));
  const m = Object.values(s.workers).find((w) => w.phase.k === 'idle' && !w.inbox.length && !held.has(w.id));
  if (!m) return false;
  land(d, m, 'retired');
  return true;
}

function hire(d: Draft, t: Task): Member {
  const { s } = d;
  const id = `w-${++s.seq}-${d.ctx.salt}` as WorkerId;
  const m: Member = {
    kind: 'member', id, role: t.role, name: pickName(s, t.role), agent: t.agent, access: t.access,
    gen: 0, residency: 'parked', inbox: [], startFailures: 0, turns: 0, phase: { k: 'idle' },
  };
  s.workers[id] = m;
  d.ev.push({ k: 'hire', id, role: m.role, type: ROLES[m.role].type, name: m.name, task: t.title, prompt: t.brief, agent: m.agent });
  return m;
}

function pickName(s: MissionState, role: Member['role']): string {
  const taken = new Set(Object.values(s.workers).map((w) => w.name));
  const pool = NAMES[role];
  for (let round = 1; ; round++) {
    const free = pool.find((n) => !taken.has(round === 1 ? n : `${n} ${round}`));
    if (free) return round === 1 ? free : `${free} ${round}`;
  }
}

function startTask(d: Draft, m: Member, t: Task) {
  const { s } = d;
  const turn = t.carry ?? (t.turns > 0 ? resumeText(t) : briefText(t, t.after.map((k) => s.tasks[k])));
  t.carry = undefined;
  t.seat = m.id;
  setRun(d, t, { k: 'running', worker: m.id });
  if (t.turns === 0 && t.origin === 'plan') d.ev.push({ k: 'msg', id: mint(d, 'm'), from: LEAD, to: m.id, kind: 'brief', text: t.brief });
  setPhase(d, m, m.workspace ? { k: 'starting', turn, sent: false } : { k: 'provisioning', turn, sent: false });
}

function answers(d: Draft) {
  for (const m of Object.values(d.s.workers)) {
    if (m.phase.k !== 'blocked' || m.phase.on.reason !== 'question') continue;
    const q = d.s.questions[m.phase.on.question];
    if (q.state.k !== 'answered') continue;
    setPhase(d, m, { k: 'starting', turn: answerText(q.state.by, q.state.text), sent: false });
  }
}

/** 맥스 깨우기: 사용자의 말은 바로, 일꾼 소식은 모아서(디바운스) 한 번에. */
function leadWake(d: Draft) {
  const { s } = d;
  if (s.news.length && s.wakeAt === null) {
    s.wakeAt = d.ctx.now + s.limits.newsDebounceMs;
    if (s.wakeAt > d.ctx.now) d.fx.push({ k: 'timer', key: `timer:wake:${s.wakeAt}`, at: s.wakeAt, then: { k: 'wake' } });
  }
  if (s.lead.phase.k !== 'idle') return;
  const newsDue = s.news.length > 0 && s.wakeAt !== null && d.ctx.now >= s.wakeAt;
  const retry = s.lead.retry;
  if (!s.lead.inbox.length && !newsDue && retry === undefined) return;
  const said = s.lead.inbox;
  const news = newsDue ? s.news : [];
  for (const n of news) if (n.question) s.questions[n.question].told = true;
  s.lead.inbox = [];
  s.lead.retry = undefined;
  if (newsDue) { s.news = []; s.wakeAt = null; }
  const fresh = said.length || news.length ? wakeText({ said, news, quiet: newsDue && workQuiet(s) }) : '';
  setPhase(d, s.lead, { k: 'starting', turn: [retry, fresh].filter((x) => x).join('\n\n'), sent: false });
}

/** provisioning·starting인데 아직 효과를 내지 않은 일꾼에게 효과 하나. 편지함은 여기서(턴 경계) 비운다. */
function emitTurn(d: Draft, w: Worker) {
  const p = w.phase;
  if ((p.k !== 'provisioning' && p.k !== 'starting') || p.sent) return;
  if (p.k === 'provisioning') {
    const t = w.kind === 'member' ? taskOf(d.s, w.id) : undefined;
    if (w.kind !== 'member' || !t) return;
    w.phase = { ...p, sent: true };
    d.fx.push({ k: 'provision', key: `provision:${w.id}:${t.key}:${w.startFailures}`, worker: w.id, task: t.key, access: t.access, upstream: t.after });
    return;
  }
  const turn = withInbox(p.turn, w.inbox);
  w.inbox = [];
  w.phase = { k: 'starting', turn, sent: true };
  if (w.residency === 'live') {
    d.fx.push({ k: 'send_turn', key: `send:${w.id}:${w.gen}:${w.turns}`, who: w.id, gen: w.gen, turn });
    return;
  }
  w.gen++;
  d.fx.push({ k: 'open_session', key: `open:${w.id}:${w.gen}`, who: w.id, gen: w.gen, turn, ...(w.session ? { resume: w.session } : {}) });
}

/** 일꾼 쪽이 더 나아갈 수 없음: 도는 일꾼, 열린 질문, 시작할 수 있는 할 일, 할 일이 될 편지함이 없다. */
export function workQuiet(s: MissionState): boolean {
  for (const m of Object.values(s.workers)) {
    if (busy(m.phase) || m.phase.k === 'blocked') return false;
    if (m.phase.k === 'idle' && m.inbox.length) return false;
  }
  if (Object.values(s.questions).some((q) => q.state.k === 'open')) return false;
  return !Object.values(s.tasks).some((t) => {
    if (t.run.k !== 'pending' || taskStatus(s.tasks, t.key) !== 'ready') return false;
    const seat = t.pin ?? t.seat;
    return !seat || s.workers[seat]?.phase.k === 'idle';
  });
}

/** 미션이 쉬는 중: 일꾼 쪽이 조용하고, 맥스도 쉬고, 맥스에게 전할 것도 없다. */
export function quiescent(s: MissionState): boolean {
  return s.lead.phase.k === 'idle' && !s.lead.inbox.length && !s.news.length && workQuiet(s);
}

function settle(d: Draft) {
  const { s } = d;
  if (s.status !== 'working' || !quiescent(s)) return;
  s.status = 'done';
  d.ev.push({ k: 'settle', text: s.leadLast || '모두 일을 마쳤어요.' });
}

/** 할 일이 없는 일꾼은 프로세스를 놓는다(세션은 남아 다음 말에 이어진다). 맥스는 미션이 쉴 때만. */
function park(d: Draft) {
  const { s } = d;
  const idle = (p: Phase) => p.k === 'idle' || p.k === 'stopped' || p.k === 'failed' || (p.k === 'blocked' && p.on.reason === 'question');
  const parkables: Worker[] = Object.values(s.workers).filter((m) => m.residency === 'live' && idle(m.phase));
  if (s.status !== 'working' && s.lead.residency === 'live' && idle(s.lead.phase)) parkables.push(s.lead);
  for (const w of parkables) {
    w.residency = 'parked';
    d.fx.push({ k: 'park', key: `park:${w.id}:${w.gen}`, who: w.id, gen: w.gen });
    d.ev.push(workerEv(w));
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function mint(d: Draft, prefix: string): string {
  return `${prefix}-${++d.s.seq}`;
}

function allWorkers(s: MissionState): Worker[] {
  return [s.lead, ...Object.values(s.workers)];
}

function workerOf(s: MissionState, who: string): Worker | undefined {
  return who === LEAD ? s.lead : s.workers[who];
}

function taskOf(s: MissionState, worker: WorkerId): Task | undefined {
  return Object.values(s.tasks).find((t) => t.run.k === 'running' && t.run.worker === worker);
}

const label = (m: Member) => `${m.name}(${m.id})`;

function blockedNote(s: MissionState, key: TaskKey): string {
  const stuck = Object.values(s.tasks).filter((t) => t.after.includes(key) && t.run.k === 'pending').map((t) => t.key);
  return stuck.length ? ` 그래서 ${stuck.join(', ')}는 막혔어요.` : '';
}

function news(d: Draft, line: string, data?: string) {
  d.s.news.push({ id: mint(d, 'n'), line, ...(data ? { data } : {}) });
}

function setPhase<W extends Worker>(d: Draft, w: W, next: W['phase'], note?: string) {
  moveTo(w.phase.k, next.k);
  w.phase = next;
  d.ev.push(workerEv(w, note));
}

function workerEv(w: Worker, note?: string): OfficeEvent {
  const p = w.phase;
  return {
    k: 'worker', id: w.id, phase: p.k, ...(p.k === 'blocked' ? { block: p.on.reason } : {}),
    ...(w.residency === 'parked' ? { parked: true } : {}), ...(note ? { note } : {}),
  };
}

function setRun(d: Draft, t: Task, run: Task['run']) {
  t.run = run;
  d.ev.push(taskEv(t));
}

function taskEv(t: Task): OfficeEvent {
  return { k: 'task', key: t.key, title: t.title, after: t.after, role: t.role, agent: t.agent, run: t.run };
}

function planItems(s: MissionState): PlanItem[] {
  return Object.values(s.tasks).sort((a, b) => a.n - b.n).map((t) => ({
    text: t.title, status: t.run.k === 'running' ? 'in_progress' : t.run.k === 'pending' ? 'pending' : 'completed',
  }));
}
