import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskStatus } from '../shared/tasks.ts';
import { LEAD } from '../server/conductor/model.ts';
import { step, type Effect, type Input } from '../server/conductor/step.ts';
import type { PlanSpec } from '../server/conductor/dag.ts';
import { Sim, assertConverged, checkInvariants, ctxAt, handback, random } from './support/conductor-sim.ts';

const spec = (key: string, more: Partial<PlanSpec> = {}): PlanSpec => ({ key, title: `${key} 하기`, brief: `${key}를 해 주세요.`, role: 'code', ...more });
const statuses = (sim: Sim) => Object.fromEntries(Object.keys(sim.s.tasks).map((k) => [k, taskStatus(sim.s.tasks, k)]));

/** 맥스가 계획을 세우고 턴을 끝낸 상태. */
function planned(specs: PlanSpec[], limits = {}) {
  const sim = new Sim(limits);
  sim.tellLead('일을 나눠서 해 주세요.');
  const r = sim.do({ k: 'lead_plan', specs });
  assert.equal(r.reply.ok, true, JSON.stringify(r.reply));
  sim.endTurn(LEAD, '계획을 세웠어요.');
  return sim;
}

test('DAG 세 칸: 의존 없는 둘이 먼저 돌고, 끝난 결과가 다음 일의 첫 턴에 자료로 들어가고, 모두 끝나면 settle', () => {
  const sim = planned([spec('research', { role: 'recherche', agent: 'codex', access: 'read' }), spec('copy', { role: 'redaction', agent: 'gemini' }), spec('site', { after: ['research'] })]);
  assert.deepEqual(statuses(sim), { research: 'running', copy: 'running', site: 'waiting' });
  assert.equal(sim.hires().length, 2);
  const [w1, w2] = [sim.workerFor('research'), sim.workerFor('copy')];
  assert.equal(sim.s.workers[w1].agent, 'codex');

  sim.beginTurn(w1);
  sim.endTurn(w1, handback({ status: 'done', summary: '빵집 세 곳: 가, 나, 다' }));
  assert.equal(sim.s.tasks.research.run.k, 'done');
  assert.ok(sim.events.some((e) => e.k === 'report' && e.who === w1 && !e.text.includes('handback')), '보고서에는 handback 블록이 없다');
  const w3 = sim.workerFor('site');
  assert.notEqual(w3, w1, '새 할 일은 새 일꾼이 맡는다');
  assert.ok(sim.take('provision', w3).upstream.includes('research' as never));
  sim.ok({ k: 'provision', key: 'x', worker: w3 as never, task: 'site' as never, access: 'write', upstream: [] }, { path: '/wt/site' });
  const first = sim.take('open_session', w3);
  assert.match(first.turn, /site를 해 주세요/);
  assert.match(first.turn, /```data\n빵집 세 곳: 가, 나, 다\n```/);

  const wake = sim.take('send_turn', LEAD);
  assert.match(wake.turn, /research/);
  assert.ok(!wake.turn.includes('모든 할 일이 끝났어요'), '아직 도는 일이 있으면 끝났다고 하지 않는다');
  sim.sig(LEAD, { k: 'turn_started' });
  sim.endTurn(LEAD, '조사가 끝났어요.');

  sim.beginTurn(w2);
  sim.endTurn(w2, '소개 글을 썼어요.');
  sim.beginTurn(LEAD);
  sim.endTurn(LEAD, '글도 나왔어요.');
  sim.ok(first);
  sim.sig(w3, { k: 'turn_started' });
  sim.endTurn(w3, handback({ status: 'done', summary: 'index.html' }));
  assert.deepEqual(statuses(sim), { research: 'done', copy: 'done', site: 'done' });
  assert.ok(!sim.events.some((e) => e.k === 'settle'), '맥스가 마지막 소식을 받기 전에는 settle하지 않는다');

  const last = sim.take('send_turn', LEAD);
  assert.match(last.turn, /모든 할 일이 끝났어요/);
  sim.sig(LEAD, { k: 'turn_started' });
  const r = sim.endTurn(LEAD, '사이트를 다 만들었어요!');
  assert.deepEqual(r.events.filter((e) => e.k === 'settle'), [{ k: 'settle', text: '사이트를 다 만들었어요!' }]);
  assert.equal(sim.s.status, 'done');
  assert.ok(r.effects.some((e) => e.k === 'park' && e.who === LEAD), '쉬는 미션의 맥스는 프로세스를 놓는다');
  assert.ok(!r.events.some((e) => e.k === 'end'), 'end는 미션을 놓아줄 때만 온다');
  assert.deepEqual(sim.do({ k: 'tick' }).events, []);
});

test('maxLive: 동시에 도는 일꾼은 한도까지만, 하나가 끝나면 다음이 시작한다', () => {
  const sim = planned(['a', 'b', 'c'].map((k) => spec(k)), { maxLive: 2 });
  assert.deepEqual(statuses(sim), { a: 'running', b: 'running', c: 'ready' });
  const wa = sim.workerFor('a');
  sim.beginTurn(wa);
  sim.endTurn(wa, '끝');
  assert.equal(statuses(sim).c, 'running');
});

test('맥스에게 간 질문: 맥스가 다음 턴에 답하지 않으면 사용자에게 가고, 사용자의 답이 다음 턴이 되고, 늦은 맥스의 답은 메모가 된다', () => {
  const sim = planned([spec('copy', { role: 'redaction' })]);
  const w = sim.workerFor('copy');
  sim.beginTurn(w);
  const asked = sim.endTurn(w, handback({ status: 'question', question: '어떤 말투로 쓸까요?', options: ['친근하게', '격식 있게'] }));
  assert.equal(sim.s.workers[w].phase.k, 'blocked');
  assert.ok(!asked.events.some((e) => e.k === 'ask'), '처음에는 맥스에게만 간다');
  assert.ok(asked.effects.some((e) => e.k === 'park' && e.who === w), '질문을 기다리는 일꾼은 프로세스를 놓는다');
  const qid = Object.keys(sim.s.questions)[0];
  assert.match(sim.take('send_turn', LEAD).turn, new RegExp(`${qid}[\\s\\S]*어떤 말투로 쓸까요`));

  sim.sig(LEAD, { k: 'turn_started' });
  const ended = sim.endTurn(LEAD, '음, 잘 모르겠어요.');
  const ask = ended.events.find((e) => e.k === 'ask');
  assert.deepEqual(ask && { who: ask.who, requestId: ask.requestId, kind: ask.kind, options: ask.options }, { who: w, requestId: qid, kind: 'question', options: ['친근하게', '격식 있게'] });

  const replied = sim.do({ k: 'user_replied', questionId: qid, text: '친근하게 써 주세요.' });
  assert.ok(replied.events.some((e) => e.k === 'ask_done' && e.requestId === qid));
  const answer = sim.take('open_session', w);
  assert.match(answer.turn, /사용자의 답이에요:\n친근하게 써 주세요/);
  assert.deepEqual(answer.resume, { id: `sess-${w}` }, '놓았던 세션을 이어서 연다');

  const late = sim.do({ k: 'lead_message', to: w, text: '격식 있게요.', replyTo: qid });
  assert.deepEqual(late.reply, { ok: true, text: '사용자가 먼저 답했어요. 이 말은 메모로 전할게요.' });
  assert.equal(sim.s.workers[w].inbox[0]?.kind, 'note');
  sim.ok(answer);
  sim.sig(w, { k: 'turn_started' });
  sim.endTurn(w, '친근하게 썼어요.');
  const followup = Object.values(sim.s.tasks).find((t) => t.origin === 'followup');
  assert.equal(followup?.pin, w, '끝난 뒤 남은 메모는 같은 일꾼의 이어서 할 일이 된다');
});

test('끝난 일꾼에게 이어서 시키면 그 일꾼에게 묶인 새 할 일이 되고, 같은 세션에서 이어진다', () => {
  const sim = planned([spec('site')]);
  const w = sim.workerFor('site');
  sim.beginTurn(w);
  sim.endTurn(w, '다 만들었어요.');
  sim.beginTurn(LEAD);
  sim.endTurn(LEAD, '사이트가 준비됐어요.');
  assert.equal(sim.s.status, 'done');

  const said = sim.do({ k: 'user_said', to: w, text: '테스트도 추가해 주세요.' });
  assert.equal(sim.s.status, 'working');
  assert.ok(said.events.some((e) => e.k === 'msg' && e.from === 'user' && e.to === w && e.kind === 'followup'));
  assert.ok(!said.events.some((e) => e.k === 'hire'), '새 일꾼을 부르지 않는다');
  const t = Object.values(sim.s.tasks).find((x) => x.origin === 'followup')!;
  assert.deepEqual([t.pin, t.run], [w, { k: 'running', worker: w }]);
  assert.equal(sim.s.tasks.site.run.k, 'done', '원래 할 일은 다시 열리지 않는다');
  const open = sim.take('open_session', w);
  assert.equal(open.turn, '테스트도 추가해 주세요.');
  assert.deepEqual(open.resume, { id: `sess-${w}` });
});

test('일하는 중에 온 말은 턴 경계까지 기다렸다가 다음 턴에 실린다', () => {
  const sim = planned([spec('site')]);
  const w = sim.workerFor('site');
  sim.beginTurn(w);
  const r = sim.do({ k: 'user_said', to: w, text: '파란색으로요.' });
  assert.ok(!r.effects.some((e) => e.k === 'send_turn' || e.k === 'open_session'), '돌고 있는 턴에는 보내지 않는다');
  sim.endTurn(w, '끝');
  assert.match(sim.take('send_turn', w).turn, /파란색으로요/, '프로세스를 쥔 채로 다음 턴을 보낸다');
});

test('시작 실패 세 번이면 회로 차단: 할 일은 실패, 일꾼도 실패, 맥스에게 소식, 네 번째 시도는 없다', () => {
  const sim = planned([spec('site'), spec('docs', { after: ['site'] })]);
  const w = sim.workerFor('site');
  sim.ok(sim.take('provision', w), { path: '/wt' });
  const gens: number[] = [];
  for (let i = 0; i < 3; i++) {
    const open = sim.take('open_session', w);
    gens.push(open.gen);
    sim.do({ k: 'effect_failed', effect: open, why: 'claude를 찾을 수 없어요' });
  }
  assert.deepEqual(gens, [1, 2, 3], '다시 열 때마다 gen이 오른다');
  assert.deepEqual(sim.s.tasks.site.run, { k: 'failed', why: 'claude를 찾을 수 없어요', attempts: 3 });
  assert.equal(sim.s.workers[w].phase.k, 'failed');
  assert.equal(taskStatus(sim.s.tasks, 'docs'), 'blocked');
  assert.ok(!sim.has('open_session', w));
  assert.match(sim.take('send_turn', LEAD).turn, /site[\s\S]*docs는 막혔어요/);
});

test('맥스 시작 실패 세 번: 미션은 오류, 일꾼은 깨끗이 멈추고, 이어서 하면 실패한 턴부터 다시 시도한다', () => {
  const sim = planned([spec('site')]);
  const w = sim.workerFor('site');
  sim.beginTurn(w);
  sim.do({ k: 'user_said', to: LEAD, text: '색을 바꿔 주세요.' });
  const reasons = ['claude를 찾을 수 없어요', 'claude를 찾을 수 없어요', '로그인이 필요해요'];
  for (const why of reasons) {
    assert.equal(sim.s.status, 'working', '세 번째 실패 전에는 오류가 아니다');
    const effect = sim.has('send_turn', LEAD) ? sim.take('send_turn', LEAD) : sim.take('open_session', LEAD);
    sim.do({ k: 'effect_failed', effect, why });
  }
  assert.equal(sim.s.status, 'error');
  assert.equal(sim.s.lead.phase.k, 'failed');
  assert.ok(!sim.has('open_session', LEAD), '네 번째 시도는 없다');
  const errors = sim.events.filter((e) => e.k === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].k === 'error' ? errors[0].message : '', /맥스를 시작하지 못했어요\. 로그인이 필요해요.*이어서 하기/);
  assert.ok(sim.has('interrupt', w), '일하던 일꾼은 끊어서 멈춘다');
  sim.sig(w, { k: 'turn_ended', outcome: 'interrupted', text: '' });
  assert.equal(sim.s.workers[w].phase.k, 'stopped');
  assert.equal(sim.s.tasks.site.run.k, 'pending', '멈춘 할 일은 같은 자리에서 다시 할 수 있다');
  assert.ok(!sim.s.news.length && sim.s.wakeAt === null);
  assert.ok(!sim.events.some((e) => e.k === 'settle' || e.k === 'end'));

  const idle = sim.do({ k: 'tick' });
  assert.deepEqual([idle.effects.filter((e) => e.k !== 'persist'), idle.events], [[], []], '오류인 미션은 저절로 다시 시작하지 않는다');

  const r = sim.do({ k: 'user_resume' });
  assert.equal(sim.s.status, 'working');
  assert.equal(sim.s.lead.startFailures, 0);
  const open = r.effects.find((e) => e.k === 'open_session' && e.who === LEAD);
  assert.ok(open && open.k === 'open_session' && /색을 바꿔 주세요/.test(open.turn), '실패한 턴의 글이 그대로 다시 간다');
  assert.equal(sim.s.lead.retry, undefined);
  assert.equal(sim.s.workers[w].phase.k !== 'stopped', true, '멈췄던 일꾼도 다시 일한다');
});

test('맥스 시작 실패 뒤 사용자가 말해도 다시 시작하고, 실패한 턴의 글과 새 말이 함께 간다', () => {
  const sim = new Sim();
  sim.start('첫 요청이에요.');
  for (let i = 0; i < 3; i++) sim.do({ k: 'effect_failed', effect: sim.take('open_session', LEAD), why: '실패' });
  assert.equal(sim.s.status, 'error');
  const r = sim.do({ k: 'user_said', to: LEAD, text: '다시 해 주세요.' });
  assert.equal(sim.s.status, 'working');
  const open = r.effects.find((e) => e.k === 'open_session' && e.who === LEAD);
  assert.ok(open && open.k === 'open_session' && /첫 요청이에요[\s\S]*다시 해 주세요/.test(open.turn));
});

test('오래된 gen의 신호는 버린다: 상태는 같은 객체 그대로', () => {
  const sim = planned([spec('site')]);
  const w = sim.workerFor('site');
  sim.ok(sim.take('provision', w), { path: '/wt' });
  sim.do({ k: 'effect_failed', effect: sim.take('open_session', w), why: '잠깐 실패' });
  assert.equal(sim.gen(w), 2);
  for (const sig of [{ k: 'turn_started' }, { k: 'turn_ended', outcome: 'ok', text: '끝' }, { k: 'activity', ev: { k: 'think', who: w } }] as const) {
    const r = step(sim.s, { k: 'signal', who: w, gen: 1, sig }, ctxAt(sim.now));
    assert.equal(r.state, sim.s);
    assert.deepEqual([r.events, r.effects], [[], []]);
  }
  const fresh = step(sim.s, { k: 'signal', who: w, gen: 2, sig: { k: 'activity', ev: { k: 'think', who: w } } }, ctxAt(sim.now));
  assert.deepEqual(fresh.events, [{ k: 'think', who: w }]);
});

test('같은 requestId의 office_message는 두 번째가 아무 일도 하지 않는다', () => {
  const sim = planned([spec('site')]);
  const w = sim.workerFor('site');
  sim.beginTurn(w);
  const first = sim.do({ k: 'lead_message', to: w, text: '색은 파랑', requestId: 'r-1' });
  assert.equal(first.reply.ok, true);
  const again = step(sim.s, { k: 'lead_message', to: w, text: '색은 파랑', requestId: 'r-1' }, ctxAt(sim.now));
  assert.equal(again.state, sim.s);
  assert.deepEqual([again.events, again.effects], [[], []]);
  assert.equal(sim.s.workers[w].inbox.length, 1);
});

test('잘못된 계획은 상태를 바꾸지 않고 맥스가 고칠 수 있는 말을 돌려준다', () => {
  const sim = planned([spec('site')]);
  const r = step(sim.s, { k: 'lead_plan', specs: [spec('docs', { after: ['nope'] })] }, ctxAt(sim.now));
  assert.equal(r.state, sim.s);
  assert.equal(r.reply.ok, false);
  assert.match(!r.reply.ok ? r.reply.error : '', /docs.*nope/);
});

test('서버 재시작: 돌던 일꾼은 쉬는 자리로, 할 일은 pending으로, 미션은 멈춤. 저절로 다시 시작하지 않고, 사용자가 말하면 같은 자리에서 잇는다', () => {
  const sim = planned([spec('site'), spec('docs')]);
  const [w1, w2] = [sim.workerFor('site'), sim.workerFor('docs')];
  sim.beginTurn(w1);
  sim.sig(w1, { k: 'approval', id: 'req-9', tool: 'Bash', label: '명령 실행', detail: 'npm test', full: true });
  sim.ok(sim.take('provision', w2), { path: '/wt/2' });
  sim.do({ k: 'user_said', to: LEAD, text: '어떻게 돼 가요?' });
  sim.beginTurn(LEAD);

  const r = sim.do({ k: 'boot' });
  assert.equal(sim.s.status, 'stopped');
  assert.deepEqual([sim.s.workers[w1].phase.k, sim.s.workers[w2].phase.k, sim.s.lead.phase.k], ['idle', 'idle', 'idle']);
  assert.deepEqual(statuses(sim), { site: 'ready', docs: 'ready' });
  assert.ok(r.events.some((e) => e.k === 'worker' && e.id === w1 && e.note === '서버가 다시 켜져서 멈췄어요.'));
  assert.ok(r.events.some((e) => e.k === 'ask_done' && e.cancelled), '열려 있던 허락 요청은 닫는다');
  assert.ok(!r.effects.some((e) => e.k === 'open_session' || e.k === 'send_turn' || e.k === 'provision'), '저절로 다시 시작하지 않는다');
  assert.ok(r.effects.some((e) => e.k === 'checkpoint' && e.worker === w1));
  sim.open = [];

  const stale = step(sim.s, { k: 'signal', who: w1, gen: 1, sig: { k: 'turn_ended', outcome: 'ok', text: '끝' } }, ctxAt(sim.now));
  assert.equal(stale.state, sim.s, '재시작 전 프로세스의 신호는 버린다');

  const hiresBefore = sim.hires().length;
  sim.do({ k: 'user_said', to: LEAD, text: '계속해 주세요.' });
  assert.equal(sim.hires().length, hiresBefore, '같은 자리에서 잇는다');
  assert.equal(sim.take('open_session', w1).turn, '멈췄던 일을 이어서 해 주세요: site 하기');
  assert.match(sim.take('open_session', w2).turn, /docs를 해 주세요/, '시작 전에 멈춘 일은 원래 첫 턴을 그대로 보낸다');
});

test('사용자가 일꾼 하나를 멈추면 그 일은 같은 자리에서 기다리고, 다시 시키면 잇는다', () => {
  const sim = planned([spec('site')]);
  const w = sim.workerFor('site');
  sim.beginTurn(w);
  const r = sim.do({ k: 'user_stop', who: w });
  const interrupt = r.effects.find((e) => e.k === 'interrupt');
  assert.equal(interrupt?.k === 'interrupt' && interrupt.who, w);
  const timer = r.effects.find((e): e is Extract<Effect, { k: 'timer' }> => e.k === 'timer')!;
  const fired = sim.do({ k: 'timer_fired', timer });
  assert.ok(fired.effects.some((e) => e.k === 'kill' && e.who === w), '멈추지 않으면 시간이 지나 끈다');
  sim.sig(w, { k: 'turn_ended', outcome: 'interrupted', text: '' });
  assert.equal(sim.s.workers[w].phase.k, 'stopped');
  assert.equal(taskStatus(sim.s.tasks, 'site'), 'ready');
  assert.ok(!sim.has('open_session', w), '멈춘 자리는 저절로 시작하지 않는다');

  sim.do({ k: 'user_resume' });
  assert.equal(sim.take('open_session', w).turn, '멈췄던 일을 이어서 해 주세요: site 하기');
});

test('도구 허락: 사용자가 답하면 같은 gen으로 answer_approval을 낸다', () => {
  const sim = planned([spec('site')]);
  const w = sim.workerFor('site');
  sim.beginTurn(w);
  const asked = sim.sig(w, { k: 'approval', id: 'req-1', tool: 'Bash', label: '명령 실행', detail: 'rm -rf build', full: true });
  const ask = asked.events.find((e) => e.k === 'ask')!;
  assert.ok(ask.k === 'ask' && ask.kind === 'approval');
  const r = sim.do({ k: 'user_approved', requestId: ask.k === 'ask' ? ask.requestId : '', allow: false });
  assert.deepEqual(r.effects.filter((e) => e.k === 'answer_approval').map((e) => e.k === 'answer_approval' && [e.approvalId, e.allow, e.gen]), [['req-1', false, sim.gen(w)]]);
  assert.equal(sim.s.workers[w].phase.k, 'working');
});

test('미션은 첫 요청과 함께 태어난다: working이고, 맥스를 열고, 바로 settle하지 않는다', () => {
  const sim = new Sim();
  const r = sim.start('빵집 사이트를 만들어 주세요.');
  assert.equal(sim.s.status, 'working');
  assert.deepEqual(r.events[0], { k: 'start', text: '빵집 사이트를 만들어 주세요.' });
  assert.ok(!r.events.some((e) => e.k === 'settle'));
  assert.match(sim.take('open_session', LEAD).turn, /빵집 사이트/);
  assert.ok(r.effects.some((e) => e.k === 'persist'), '태어나자마자 저장한다');
});

test('release: 일꾼은 모두 떠나고, 열린 질문은 닫히고, 쥔 프로세스는 끝내고, end를 낸다', () => {
  const sim = planned([spec('a'), spec('b', { role: 'redaction' })]);
  const [wa, wb] = [sim.workerFor('a'), sim.workerFor('b')];
  sim.beginTurn(wa);
  sim.beginTurn(wb);
  sim.endTurn(wb, handback({ status: 'question', question: '고르세요', audience: 'user' }));
  const r = sim.do({ k: 'release' });
  assert.deepEqual(r.events.filter((e) => e.k === 'leave').map((e) => e.k === 'leave' && e.who).sort(), [wa, wb].sort());
  assert.ok(r.events.some((e) => e.k === 'ask_done' && e.cancelled), '사용자에게 간 질문은 거둔다');
  assert.ok(r.effects.some((e) => e.k === 'kill' && e.who === wa), '도는 프로세스는 끝낸다');
  assert.deepEqual(r.events.filter((e) => e.k === 'end'), [{ k: 'end', ok: false, text: '계획을 세웠어요.', ms: 0, stopped: true }]);
  assert.equal(sim.s.status, 'stopped');
  assert.deepEqual([sim.s.tasks.a.run.k, sim.s.tasks.b.run.k], ['pending', 'pending']);
});

test('할 일 없는 대화: 맥스의 턴이 끝나면 바로 settle', () => {
  const sim = new Sim();
  sim.tellLead('안녕!');
  const r = sim.endTurn(LEAD, '안녕하세요!');
  assert.deepEqual(r.events.filter((e) => e.k === 'settle'), [{ k: 'settle', text: '안녕하세요!' }]);
});

test('소식은 디바운스로 모아서 한 번에 깨운다', () => {
  const sim = planned([spec('a'), spec('b')], { newsDebounceMs: 1500 });
  const [wa, wb] = [sim.workerFor('a'), sim.workerFor('b')];
  sim.beginTurn(wa);
  sim.beginTurn(wb);
  const first = sim.endTurn(wa, '끝 a');
  const timer = first.effects.find((e): e is Extract<Effect, { k: 'timer' }> => e.k === 'timer');
  assert.ok(timer, '타이머를 건다');
  assert.ok(!sim.has('send_turn', LEAD));
  sim.endTurn(wb, '끝 b');
  sim.now = timer.at;
  sim.do({ k: 'timer_fired', timer });
  const wake = sim.take('send_turn', LEAD);
  assert.match(wake.turn, /a[\s\S]*b/);
  assert.match(wake.turn, /모든 할 일이 끝났어요/);
});

test('타이머가 1ms 일찍 깨어도 소식을 전한다: 타이머는 한 번뿐이라 다시 오지 않는다', () => {
  const sim = planned([spec('a')], { newsDebounceMs: 1500 });
  const w = sim.workerFor('a');
  sim.beginTurn(w);
  const first = sim.endTurn(w, '끝 a');
  const timer = first.effects.find((e): e is Extract<Effect, { k: 'timer' }> => e.k === 'timer')!;
  sim.now = timer.at - 1;
  sim.do({ k: 'timer_fired', timer });
  assert.match(sim.take('send_turn', LEAD).turn, /끝 a/);
});

test('저장소의 결과: task_result는 끝난 할 일에만 붙고 두 번 받아도 같으며, user_retire는 쉬는 일꾼만 내보낸다', () => {
  const sim = planned([spec('a')]);
  const w = sim.workerFor('a');
  sim.beginTurn(w);
  assert.equal(sim.do({ k: 'user_retire', who: w }).reply.ok, false, '일하는 일꾼은 내보내지 않는다');
  sim.do({ k: 'task_result', task: 'a', patch: { branch: 'bureau/m/a' } });
  assert.equal(sim.s.tasks.a.run.k, 'running', '돌고 있는 할 일에는 붙이지 않는다');
  sim.endTurn(w, handback({ status: 'done', summary: '했어요' }));
  assert.equal(sim.take('checkpoint', w).task, 'a', '턴 끝의 보관은 그 할 일을 안다');
  const patch = { branch: 'bureau/m/a', files: 2, mergeable: 'clean' as const, by: w };
  sim.do({ k: 'task_result', task: 'a', patch, note: '보관하지 않은 파일: .env(비밀일 수 있어요)' });
  assert.deepEqual(sim.s.tasks.a.run, { k: 'done', result: { summary: '했어요', ...patch } });
  assert.ok(sim.events.some((e) => e.k === 'worker' && e.id === w && e.note?.includes('.env')), '메모는 그 일꾼의 카드로 간다');
  assert.deepEqual(sim.do({ k: 'task_result', task: 'a', patch }).events, [], '같은 결과를 두 번 받아도 한 번과 같다');
  assert.equal(sim.do({ k: 'user_retire', who: w }).reply.ok, true);
  assert.equal(sim.s.workers[w].phase.k, 'retired');
  assert.ok(sim.has('retire', w), '내보내면 작업 폴더를 정리한다');
});

test('boot의 lost: 작업 폴더가 사라진 일꾼은 다음 일 때 다시 준비한다', () => {
  const sim = planned([spec('a')]);
  const w = sim.workerFor('a');
  sim.beginTurn(w);
  assert.ok(sim.s.workers[w].workspace);
  sim.do({ k: 'boot', lost: [w] });
  assert.equal(sim.s.workers[w].workspace, undefined);
  sim.do({ k: 'user_resume' });
  assert.ok(sim.has('provision', w), '같은 일꾼이 작업 폴더부터 다시 준비한다');
});

/** 무작위 입력 수천 개: 불법 단계 이동(던짐)이 없고, 매 걸음 불변식과 멱등성이 지켜진다. */
test('무작위 걸음: 어떤 순서로 와도 던지지 않고, converge는 늘 고정점에 있다', () => {
  const seen = new Set<string>();
  for (let seed = 1; seed <= 60; seed++) {
    const rnd = random(seed);
    const pick = <T>(xs: readonly T[]): T => xs[rnd(xs.length)];
    const sim = new Sim({ maxLive: 2, maxWorkers: 3, newsDebounceMs: rnd(2) * 500 });
    sim.start('일을 나눠서 해 주세요.');
    const texts = ['끝', handback({ status: 'done', summary: '요약' }), handback({ status: 'question', question: '어떻게?' }),
      handback({ status: 'question', question: '고르세요', audience: 'user', options: ['a'] }), handback({ status: 'blocked', why: '권한' }), '```handback\n{bad'];
    for (let i = 0; i < 250; i++) {
      const active = Object.values(sim.s.workers).filter((m) => ['starting', 'working', 'blocked'].includes(m.phase.k)).map((m) => m.id);
      const who = active.length && rnd(3) ? pick(active) : pick([LEAD, ...Object.keys(sim.s.workers)]);
      const qs = Object.keys(sim.s.questions);
      const asks = sim.events.flatMap((e) => (e.k === 'ask' && e.kind === 'approval' ? [e.requestId] : []));
      const keys = Object.keys(sim.s.tasks);
      const options: (() => Input)[] = [
        () => ({ k: 'user_said', to: who, text: '이것도 해 줘' }),
        () => ({ k: 'lead_plan', specs: [spec(pick(['a', 'b', 'c', 'd'])), spec(pick(['e', 'f']), { after: [pick(['a', 'b'])] })] }),
        () => ({ k: 'lead_message', to: who, text: '답', requestId: pick(['r1', 'r2', undefined as never]) }),
        () => ({ k: 'lead_cancel', target: rnd(2) ? { task: pick(keys.length ? keys : ['a']) } : { worker: who } }),
        () => ({ k: 'user_stop', ...(rnd(3) ? { who } : {}) }),
        () => ({ k: 'user_resume' }),
        () => ({ k: 'user_replied', questionId: pick(qs.length ? qs : ['q-0']), text: '좋아요' }),
        () => ({ k: 'user_approved', requestId: pick(asks.length ? asks : ['a-0']), allow: rnd(2) === 0 }),
        () => ({ k: 'signal', who, gen: sim.gen(who), sig: { k: 'turn_started' } }),
        () => ({ k: 'signal', who, gen: sim.gen(who), sig: { k: 'turn_ended', outcome: pick(['ok', 'ok', 'error', 'interrupted'] as const), text: pick(texts) } }),
        () => ({ k: 'signal', who, gen: sim.gen(who), sig: { k: 'approval', id: `req-${i}`, tool: 'Bash', label: 'x', detail: 'y', full: true } }),
        () => ({ k: 'signal', who, gen: sim.gen(who) - rnd(2), sig: { k: 'exited' } }),
        () => ({ k: 'boot', ...(rnd(2) ? { lost: [who] } : {}) }),
        () => ({ k: 'tick' }),
        () => ({ k: 'release' }),
        // 내보내기는 드물게: 자주 오면 일꾼이 질문과 이어서 시킨 일까지 가기 전에 떠난다
        () => (rnd(4)
          ? { k: 'task_result', task: pick(keys.length ? keys : ['a']), patch: { branch: 'bureau/m/x', files: rnd(3) }, ...(rnd(2) ? { note: '보관 메모' } : {}) }
          : { k: 'user_retire', who }),
      ];
      if (sim.open.length) {
        const settleOne = (): Input => {
          const e = sim.open.splice(rnd(sim.open.length), 1)[0];
          return e.k === 'timer' ? { k: 'timer_fired', timer: e } : rnd(3) ? { k: 'effect_ok', effect: e, out: { p: 1 } } : { k: 'effect_failed', effect: e, why: '실패' };
        };
        options.push(settleOne, settleOne, settleOne, settleOne);
      }
      sim.now += rnd(3) * 700;
      const input = pick(options)();
      try { sim.do(input); } catch (err) { throw new Error(`seed ${seed} step ${i} ${JSON.stringify(input)}: ${(err as Error).message}`); }
      for (const m of Object.values(sim.s.workers)) seen.add(m.phase.k === 'blocked' ? `blocked:${m.phase.on.reason}` : m.phase.k);
      for (const q of Object.values(sim.s.questions)) seen.add(`question:${q.audience}:${q.state.k}`);
      for (const t of Object.values(sim.s.tasks)) seen.add(`task:${t.origin}:${t.run.k}`);
      if (sim.s.status === 'done' && Object.keys(sim.s.tasks).length) seen.add('settled-after-work');
    }
    checkInvariants(sim.s);
    assertConverged(sim.s, sim.now);
  }
  const want = ['provisioning', 'starting', 'working', 'blocked:approval', 'blocked:question', 'stopping', 'idle', 'stopped', 'failed', 'retired',
    'question:lead:answered', 'question:user:answered', 'question:lead:void', 'task:plan:done', 'task:plan:failed', 'task:plan:cancelled',
    'task:followup:running', 'task:followup:done', 'settled-after-work'];
  assert.deepEqual(want.filter((k) => !seen.has(k)), [], '걸음이 모든 단계와 갈래를 지나간다');
});
