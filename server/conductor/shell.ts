// 진행자(Conductor)의 셸. 미션 하나에 하나. 정하는 일은 모두 순수 코어(step.ts)가 하고, 여기는 코어가 낸 효과를 실행하고,
// 어댑터의 신호를 코어의 입력으로 옮기고, 이벤트를 내보내고, 제어 상태를 저장한다.
// 밖에서 쓰는 것: Conductor.create / Conductor.open, input, view, close. 맥스의 MCP 호출은 LeadMcp가 토큰으로 찾아 넣는다.
import { randomBytes } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { claudePowers, relToFolder, ROLE_POWERS } from '../../shared/activity.ts';
import type { AgentKind, OfficeEvent, Quota } from '../../shared/protocol.ts';
import type { AgentAdapter, AgentSession, RawTap, SessionRef, SessionSpec, WorkerSignal } from '../agents/adapter.ts';
import { adapterFor } from '../agents/registry.ts';
import { loadSaved, reapOrphans, type ProcRecord, type Saved, type Usage } from './boot.ts';
import { LEAD_TOOL_IDS, leadMcpConfig, type LeadMcp } from './lead-mcp.ts';
import { DEFAULT_LIMITS, LEAD, type Limits, type MissionState, type Opaque, type Who } from './model.ts';
import { recapText, workerPrompt } from './prompts.ts';
import { createMission, step, type Effect, type Input, type Reply, type Signal, type StepCtx, type StepResult } from './step.ts';
import { parseHandback } from './text.ts';

/** 브라우저가 넣는 입력 */
export type UserInput = Extract<Input, { k: 'user_said' | 'user_replied' | 'user_approved' | 'user_stop' | 'user_resume' }>;

export interface ConductorDeps {
  missionId: string;
  /** 미션 폴더: 맥스와 모든 일꾼이 여기서 일한다 */
  folder: string;
  /** `.bureau/missions/<id>.state.json` */
  stateFile: string;
  /** 사무실 이벤트. 받는 쪽이 시각을 찍고 방송하고, typing만 빼고 기록(Logged[])에 남긴다 */
  emit(ev: OfficeEvent): void;
  /** 화면에 보이지 않는 진단 줄(예상 못 한 종료, 읽을 수 없는 출력, 이어가기 실패) */
  journal?(line: string): void;
  onQuota?(q: Quota): void;
  installed: readonly AgentKind[];
  /** 모델은 CLI마다 따로다: chefModel·teamModel은 claude의 이름, codexModel은 codex의 이름('' = CLI 기본값) */
  settings(): { autonomy: 'ask' | 'auto'; chefModel: string; teamModel: string; codexModel: string };
  /** 맥스의 지시문 */
  leadPrompt(): string;
  leadMcp: LeadMcp;
  /** LeadMcp를 단 서버의 주소, 예: http://127.0.0.1:4848 */
  mcpBase: string;
  adapters?: (kind: AgentKind) => AgentAdapter;
  /** 개발용 녹화(BUREAU_RECORD): 여는 세션마다 원문 줄을 받을 곳 */
  tap?(kind: AgentKind, who: Who): RawTap | undefined;
  limits?: Partial<Limits>;
  now?: () => number;
}

/** 지금 쥐고 있는 프로세스 하나 */
interface Live {
  who: Who;
  gen: number;
  session: AgentSession;
  /** 맥스만: 이 프로세스의 MCP 토큰 */
  token: string | null;
  /** 이 프로세스가 턴을 시작했다(init). 그 전에 끝나면 시작 실패다 */
  started: boolean;
  /** --resume으로 열었다. 시작하기 전에 끝나면 요약을 붙여 새 세션으로 연다(한 번만) */
  resume: SessionRef | null;
  turn: string;
  turnAt: number | null;
}

const asRef = (o: Opaque | undefined): SessionRef | null =>
  o && typeof o.id === 'string' && o.id && typeof o.cwd === 'string' ? { id: o.id, cwd: o.cwd } : null;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Conductor {
  private deps: ConductorDeps;
  private state: MissionState;
  private now: () => number;
  private live = new Map<Who, Live>();
  private procs: Record<string, ProcRecord>;
  private usage: Record<string, Usage>;
  /** 이 프로세스에서 시작한 효과의 키. 키는 의도마다 하나라서, 같은 키가 다시 오면 중복이다 */
  private seen = new Set<string>();
  private timers = new Map<string, NodeJS.Timeout>();
  private queue: Input[] = [];
  private busy = false;
  private closed = false;

  private constructor(deps: ConductorDeps, state: MissionState, saved?: Saved) {
    this.deps = deps;
    this.state = state;
    this.now = deps.now ?? Date.now;
    this.procs = saved?.procs ?? {};
    this.usage = saved?.usage ?? {};
    mkdirSync(path.dirname(deps.stateFile), { recursive: true });
  }

  /** 새 미션: 첫 요청과 함께 만들고 바로 맥스를 깨운다. */
  static create(deps: ConductorDeps, opening: string): Conductor {
    const limits = { ...DEFAULT_LIMITS, ...deps.limits };
    const now = (deps.now ?? Date.now)();
    const first = createMission(opening, { now, installed: deps.installed, salt: salt() }, limits);
    const c = new Conductor(deps, first.state);
    c.busy = true;
    try { c.apply(first); c.drain(); } finally { c.busy = false; }
    return c;
  }

  /** 저장한 미션을 다시 연다: 남은 프로세스를 끝내고 boot를 넣는다. 미션은 멈춘 채로 열린다(저절로 다시 시작하지 않는다). */
  static async open(deps: ConductorDeps): Promise<Conductor> {
    const saved = loadSaved(deps.stateFile);
    if (!saved) throw new Error('저장된 미션 상태를 읽을 수 없어요.');
    await reapOrphans(Object.values(saved.procs));
    const c = new Conductor(deps, saved.mission, { ...saved, procs: {} });
    c.feed({ k: 'boot' });
    return c;
  }

  /** 브라우저의 입력. */
  input(i: UserInput): Reply { return this.feed(i); }

  /** 읽기 전용(살아 있는 핸들은 없다). */
  view(): Readonly<MissionState> { return this.state; }

  /** 놓아주기: 일꾼은 모두 떠나고(leave), end를 내고, 프로세스를 모두 끝낸다. 두 번 불러도 같다. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.feed({ k: 'release' });
    this.closed = true;
    for (const h of this.timers.values()) clearTimeout(h);
    this.timers.clear();
    const held = [...this.live.values()];
    for (const l of held) { this.revoke(l); l.session.kill(); }
    for (const end = Date.now() + 5000; held.some((l) => l.session.alive) && Date.now() < end;) await new Promise((r) => setTimeout(r, 20));
    this.live.clear();
    this.procs = {};
    this.save();
  }

  // ── 입력과 효과 ──

  private ctx(): StepCtx { return { now: this.now(), installed: this.deps.installed, salt: salt() }; }

  /** 밖에서 온 입력: 바로 돌리고 답을 돌려준다. 그 입력이 낳은 입력(효과의 결과)은 뒤에 이어서 돌린다. */
  private feed(i: Input): Reply {
    if (this.closed) return { ok: false, error: '이미 닫힌 미션이에요.' };
    const outer = !this.busy;
    this.busy = true;
    try {
      const reply = this.apply(step(this.state, i, this.ctx()));
      if (outer) this.drain();
      return reply;
    } finally { if (outer) this.busy = false; }
  }

  /** 안에서 생긴 입력(신호, 효과 결과, 타이머). 돌리는 중이면 줄을 세운다. */
  private post(i: Input) {
    if (this.closed) return;
    this.queue.push(i);
    if (this.busy) return;
    this.busy = true;
    try { this.drain(); } finally { this.busy = false; }
  }

  private drain() {
    for (let i = this.queue.shift(); i; i = this.queue.shift()) this.apply(step(this.state, i, this.ctx()));
  }

  private apply(r: StepResult): Reply {
    this.state = r.state;
    for (const ev of r.events) this.emit(ev);
    for (const e of r.effects) this.exec(e);
    return r.reply;
  }

  private emit(ev: OfficeEvent) {
    if (ev.k === 'leave') {
      const u = this.usage[ev.who];
      ev = { ...ev, tokens: u?.tokens ?? 0, tools: u?.tools ?? 0, ms: u?.ms ?? 0 };
    }
    // 미션 폴더의 전체 경로는 화면에 가지 않는다
    this.deps.emit(JSON.parse(relToFolder(JSON.stringify(ev), this.deps.folder)) as OfficeEvent);
  }

  private exec(e: Effect) {
    if (e.k === 'persist') { this.save(); return; }
    if (this.seen.has(e.key)) return;
    this.seen.add(e.key);
    switch (e.k) {
      case 'timer': {
        const h = setTimeout(() => { this.timers.delete(e.key); this.post({ k: 'timer_fired', timer: e }); }, Math.max(0, e.at - this.now()));
        h.unref();
        this.timers.set(e.key, h);
        return;
      }
      // 폴더 미션: 모두 같은 미션 폴더에서 일하고, 보관(커밋)할 것이 없다
      case 'provision': this.post({ k: 'effect_ok', effect: e, out: { kind: 'folder' } }); return;
      case 'checkpoint':
      case 'retire': this.post({ k: 'effect_ok', effect: e }); return;
      case 'open_session':
        try {
          this.open(e.who, e.gen, e.turn, asRef(e.resume));
          this.post({ k: 'effect_ok', effect: e });
        } catch (err) { this.post({ k: 'effect_failed', effect: e, why: errText(err) }); }
        return;
      case 'send_turn': {
        const l = this.current(e.who, e.gen);
        try {
          if (l?.session.alive) { l.session.send({ text: e.turn }, 'turn'); return; }
        } catch { /* 그사이 프로세스가 끝났다: 아래에서 다시 연다 */ }
        // 프로세스가 사라진 세션: 셸이 같은 세션을 --resume으로 다시 연다
        const ref = asRef(e.who === LEAD ? this.state.lead.session : this.state.workers[e.who]?.session);
        try {
          if (!ref) throw new Error('이어갈 세션이 없어요.');
          if (l) this.forget(l);
          this.open(e.who, e.gen, e.turn, ref);
        } catch (err) { this.post({ k: 'effect_failed', effect: e, why: errText(err) }); }
        return;
      }
      case 'answer_approval': this.current(e.who, e.gen)?.session.answerApproval(e.approvalId, e.allow); return;
      case 'interrupt':
      case 'kill': {
        const l = this.current(e.who, e.gen);
        // 쥔 프로세스가 없으면 이미 끝난 것과 같다
        if (!l) { this.post({ k: 'signal', who: e.who, gen: e.gen, sig: { k: 'exited' } }); return; }
        if (e.k === 'interrupt') l.session.interrupt(); else l.session.kill();
        return;
      }
      case 'park': {
        const l = this.current(e.who, e.gen);
        if (!l) return;
        this.revoke(l);
        void l.session.park();
        return;
      }
    }
  }

  private current(who: Who, gen: number): Live | undefined {
    const l = this.live.get(who);
    return l && l.gen === gen ? l : undefined;
  }

  // ── 세션 ──

  private open(who: Who, gen: number, turn: string, resume: SessionRef | null) {
    const prev = this.live.get(who);
    if (prev) { this.forget(prev); prev.session.kill(); }
    const kind: AgentKind = who === LEAD ? 'claude' : this.state.workers[who].agent;
    const token = who === LEAD ? this.deps.leadMcp.issue((i) => this.feed(i)) : null;
    const l: Live = { who, gen, token, started: false, resume, turn, turnAt: null } as Live;
    try {
      l.session = (this.deps.adapters ?? adapterFor)(kind).open(this.spec(who, token, resume), { text: turn }, (sig) => this.onSignal(l, sig));
    } catch (err) {
      if (token) this.deps.leadMcp.revoke(token);
      throw err;
    }
    this.live.set(who, l);
    if (l.session.pid) { this.procs[who] = { pid: l.session.pid, bin: l.session.bin }; this.save(); }
  }

  private spec(who: Who, token: string | null, resume: SessionRef | null): SessionSpec {
    const st = this.deps.settings();
    const kind: AgentKind = who === LEAD ? 'claude' : this.state.workers[who].agent;
    const tap = this.deps.tap?.(kind, who);
    const base = { cwd: this.deps.folder, autonomy: st.autonomy, ...(resume ? { resume } : {}), ...(tap ? { tap } : {}) };
    if (who === LEAD) {
      const p = claudePowers(ROLE_POWERS.chef, 'write');
      // 사용자의 커넥터는 맥스에게 지금처럼 남긴다(엄격 MCP를 켜지 않는다)
      return {
        ...base, access: 'write', powers: { tools: p.tools, preapproved: [...p.preapproved, ...LEAD_TOOL_IDS] }, systemPrompt: this.deps.leadPrompt(),
        mcpConfig: leadMcpConfig(this.deps.mcpBase, token!), ...(st.chefModel ? { model: st.chefModel } : {}),
      };
    }
    const m = this.state.workers[who];
    const task = Object.values(this.state.tasks).find((t) => t.run.k === 'running' && t.run.worker === who);
    const model = kind === 'claude' ? (st.teamModel === 'inherit' ? st.chefModel : st.teamModel) : kind === 'codex' ? st.codexModel : '';
    // 일꾼에게는 MCP가 하나도 없다: 자기 직무의 도구만
    return {
      ...base, access: m.access, powers: claudePowers(ROLE_POWERS[m.role], m.access), systemPrompt: workerPrompt(m, task), strictMcp: true,
      ...(model ? { model } : {}),
    };
  }

  private onSignal(l: Live, sig: WorkerSignal) {
    if (this.closed || this.live.get(l.who) !== l) return;
    const { who, gen } = l;
    const tell = (s: Signal) => this.post({ k: 'signal', who, gen, sig: s });
    const show = (ev: OfficeEvent) => tell({ k: 'activity', ev });
    switch (sig.k) {
      case 'session':
        l.started = true;
        l.resume = null;
        l.turnAt = this.now();
        if (sig.ref.id) tell({ k: 'session', ref: { id: sig.ref.id, cwd: sig.ref.cwd } });
        // 미션의 모델은 맥스의 것이다(화면의 「맥스의 두뇌」)
        if (who === LEAD && sig.model) show({ k: 'init', model: sig.model, auth: sig.auth ?? '' });
        tell({ k: 'turn_started' });
        return;
      case 'think': show({ k: 'think', who }); return;
      case 'typing': show({ k: 'typing', who, text: sig.text }); return;
      case 'say': {
        const text = who === LEAD ? sig.text : parseHandback(sig.text).text;
        if (text) show({ k: 'say', who, text });
        return;
      }
      // 보드는 할 일 그래프에서 나온다
      case 'plan': return;
      case 'act': show({ k: 'act', who, id: sig.id, kind: sig.kind, tool: sig.tool, label: sig.label, detail: sig.detail }); return;
      case 'act_done': show({ k: 'act_done', who, id: sig.id, ok: sig.ok }); return;
      case 'approval': tell({ k: 'approval', id: sig.id, tool: sig.tool, label: sig.label, detail: sig.detail, full: sig.full }); return;
      case 'approval_cancelled': tell({ k: 'approval_cancelled', id: sig.id }); return;
      case 'quota': this.deps.onQuota?.({ fiveHour: sig.fiveHour, resetsAt: sig.resetsAt }); return;
      case 'usage': {
        const u = (this.usage[who] ??= { tokens: 0, tools: 0, ms: 0 });
        u.tokens += sig.tokens;
        u.tools += sig.tools;
        return;
      }
      case 'turn_end': {
        // 턴을 시작하지 못한 프로세스의 턴 끝: exit에서 시작 실패로 다룬다
        if (!l.started) return;
        if (l.turnAt !== null) {
          const u = (this.usage[who] ??= { tokens: 0, tools: 0, ms: 0 });
          u.ms += this.now() - l.turnAt;
          l.turnAt = null;
        }
        tell({ k: 'turn_ended', outcome: sig.interrupted ? 'interrupted' : sig.ok ? 'ok' : 'error', text: sig.ok ? sig.text : sig.text || sig.error || '' });
        return;
      }
      case 'exit': {
        if (!l.started && l.resume) { this.restartFresh(l); return; }
        this.forget(l);
        if (!sig.expected) this.deps.journal?.(`${who} 프로세스가 끝났어요(코드 ${sig.code}, 신호 ${sig.signal}): ${sig.stderrTail.slice(-500)}`);
        tell({ k: 'exited', ...(sig.expected ? {} : { why: sig.stderrTail.split('\n').filter(Boolean).slice(-3).join(' ') || undefined }) });
        return;
      }
      case 'diag': this.deps.journal?.(`${who}: ${sig.line}`); return;
    }
  }

  /** 이어가기가 실패했다(오래된 세션은 CLI가 지운다): 같은 gen으로 새 세션을 열고 첫 메시지 앞에 지금까지의 요약을 붙인다. */
  private restartFresh(l: Live) {
    this.forget(l);
    this.deps.journal?.(`${l.who}: 예전 세션을 이어갈 수 없어서 요약을 붙여 새로 시작해요.`);
    try {
      this.open(l.who, l.gen, `${recapText(this.state, l.who)}\n\n${l.turn}`, null);
    } catch (err) {
      this.post({ k: 'signal', who: l.who, gen: l.gen, sig: { k: 'exited', why: errText(err) } });
    }
  }

  private revoke(l: Live) {
    if (l.token) { this.deps.leadMcp.revoke(l.token); l.token = null; }
  }

  /** 이 프로세스를 더 이상 쥐고 있지 않다. 이 뒤에 오는 그 프로세스의 신호는 버린다. */
  private forget(l: Live) {
    this.revoke(l);
    if (this.live.get(l.who) !== l) return;
    this.live.delete(l.who);
    if (this.procs[l.who]?.pid === l.session.pid) { delete this.procs[l.who]; this.save(); }
  }

  // ── 저장 ──

  /** 바뀔 때마다 바로 쓴다(임시 파일에 쓰고 이름 바꾸기). 파일이 작고 바뀌는 일이 드물어서 모으지 않는다 */
  private save() {
    const saved: Saved = { v: 1, mission: this.state, procs: this.procs, usage: this.usage };
    const tmp = `${this.deps.stateFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(saved));
    renameSync(tmp, this.deps.stateFile);
  }
}

/** 일꾼 id 끝의 짧은 무작위 글자 `[a-z0-9]{4}` */
function salt(): string {
  return randomBytes(4).readUInt32BE(0).toString(36).padStart(4, '0').slice(-4);
}
