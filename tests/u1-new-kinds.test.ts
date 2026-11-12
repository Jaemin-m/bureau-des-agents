// 손으로 쓴 새 이벤트 기록(작업 그래프, 세 CLI의 일꾼, 질문과 답, 끝난 일꾼에게 이어서 시키기, settle)을 스토어에 접는다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Logged, MissionInfo } from '../shared/protocol.ts';
import { taskStatus, type TaskGraph } from '../shared/tasks.ts';
import { emptyStats } from '../shared/activity.ts';
import { loadStore } from './support/demo-fold.ts';

const LOG = new URL('./fixtures/scenarios/u1-new-kinds.logged.jsonl', import.meta.url);
const log = readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Logged);

const mission: MissionInfo = {
  id: 'u1-scenario', title: '빵집 사이트', prompt: '동네 빵집 소개 사이트를 만들어 주세요.', folder: '미션/빵집', createdAt: log[0].at,
  workMs: 0, status: 'working', stats: emptyStats(), files: [],
};

interface Agent { id: string; status: string; report: string; agent?: string; phase?: string; block?: string; thread?: { id: string; kind: string; from: string }[] }
interface View {
  order: string[]; agents: Record<string, Agent>; tasks: TaskGraph & Record<string, { title: string }>;
  asks: Record<string, { who: string; kind: string; options?: string[] }>; settled: { text: string } | null;
  busySince: number | null; workMs: number; feed: { who: string; text: string; kind: string }[]; stats: { agents: number };
  chef: { thinkingAt: number }; final: unknown;
}
type Helpers = { agentKindOf(a: Agent): string; phaseOf(a: Agent): string };

const KEYS = ['order', 'agents', 'tasks', 'asks', 'settled', 'busySince', 'workMs', 'feed', 'stats', 'chef', 'final'] as const;
const snapshot = (st: Record<string, unknown>) => structuredClone(Object.fromEntries(KEYS.map((k) => [k, st[k]]))) as unknown as View;

/** 기록을 처음부터 접으면서, 주어진 시각의 이벤트까지 접은 상태를 하나씩 찍어 둔다. */
async function foldWithCheckpoints(ats: number[]) {
  const { useOffice, agentKindOf, phaseOf } = await loadStore<Helpers>();
  useOffice.setState({ replaying: true });
  useOffice.getState().resetMission(mission);
  const at: Record<number, View> = {};
  for (let i = 0; i < log.length; i++) {
    useOffice.getState().apply(log[i].ev, log[i].at, false);
    const lastOfInstant = log[i + 1]?.at !== log[i].at;
    if (lastOfInstant && ats.includes(log[i].at)) at[log[i].at] = snapshot(useOffice.getState());
  }
  return { at, end: useOffice.getState() as unknown as View, agentKindOf, phaseOf };
}

const PLANNED = 1795000001500;
const DUP_HIRE = 1795000005500;
const TWO_ASKS = 1795000007100;
const FIRST_ASK_CLOSED = 1795000008100;
const FIRST_SETTLE = 1795000018000;
const FOLLOWUP = 1795000030100;
const run = foldWithCheckpoints([PLANNED, DUP_HIRE, TWO_ASKS, FIRST_ASK_CLOSED, FIRST_SETTLE, FOLLOWUP]);
const statuses = (v: View) => Object.fromEntries(Object.keys(v.tasks).map((k) => [k, taskStatus(v.tasks, k)]));

test('작업 그래프: 계획 직후 의존 없는 일은 ready, 의존이 있는 일은 waiting', async () => {
  const { at } = await run;
  assert.deepEqual(statuses(at[PLANNED]), { research: 'ready', copy: 'ready', site: 'waiting' });
});

test('작업 그래프: 끝에는 세 할 일이 모두 done이고 실행 기록만 남는다', async () => {
  const { end } = await run;
  assert.deepEqual(statuses(end), { research: 'done', copy: 'done', site: 'done' });
  assert.deepEqual(Object.keys(end.tasks), ['research', 'copy', 'site']);
  assert.deepEqual(end.tasks.site.after, ['research']);
  assert.ok(!('state' in end.tasks.site), '상태는 저장하지 않고 계산한다');
});

test('일꾼: 같은 id로 다시 hire가 와도 한 명이고, CLI 종류가 남는다', async () => {
  const { at, end, agentKindOf } = await run;
  assert.equal(at[DUP_HIRE].agents['w-1-ab12'].phase, 'working', '다시 온 hire는 단계를 지우지 않는다');
  assert.equal(at[DUP_HIRE].agents['w-1-ab12'].thread?.length, 1, '대화도 그대로다');
  assert.deepEqual(end.order, ['w-1-ab12', 'w-2-cd34', 'w-3-ef56']);
  assert.equal(end.stats.agents, 3);
  assert.deepEqual(end.order.map((id) => agentKindOf(end.agents[id])), ['codex', 'gemini', 'claude']);
  assert.equal(end.feed.filter((l) => l.kind === 'hire').length, 3);
});

test('일꾼: 단계는 worker 이벤트를 따르고 예전 status도 함께 맞춘다', async () => {
  const { at, end, phaseOf } = await run;
  assert.equal(phaseOf(at[TWO_ASKS].agents['w-2-cd34']), 'blocked');
  assert.equal(at[TWO_ASKS].agents['w-2-cd34'].block, 'question');
  assert.equal(at[TWO_ASKS].agents['w-1-ab12'].block, 'approval');
  for (const id of end.order) {
    assert.equal(phaseOf(end.agents[id]), 'idle', id);
    assert.equal(end.agents[id].status, 'done', id);
    assert.equal(end.agents[id].block, undefined, id);
  }
});

test('요청: 열린 요청은 온 순서대로 쌓이고, 각자 주인과 종류가 있다', async () => {
  const { at } = await run;
  const asks = at[TWO_ASKS].asks;
  assert.deepEqual(Object.keys(asks), ['q-1', 'r-7']);
  assert.deepEqual(asks['q-1'], { ...asks['q-1'], who: 'w-2-cd34', kind: 'question', options: ['친근하게', '격식 있게'] });
  assert.deepEqual(asks['r-7'], { ...asks['r-7'], who: 'w-1-ab12', kind: 'approval' });
});

test('요청: ask_done은 그 requestId의 요청만 닫는다(다른 일꾼의 승인 요청은 열린 채로 남는다)', async () => {
  const { at, end } = await run;
  assert.deepEqual(Object.keys(at[FIRST_ASK_CLOSED].asks), ['r-7']);
  assert.deepEqual(end.asks, {});
});

test('대화: 질문의 답과 이어서 시킨 말은 그 일꾼의 대화에 남고, 맥스의 start로 오해하지 않는다', async () => {
  const { at, end } = await run;
  assert.deepEqual(end.agents['w-2-cd34'].thread?.map((m) => [m.id, m.kind, m.from]), [['m-2', 'answer', 'user']]);
  assert.deepEqual(end.agents['w-1-ab12'].thread?.map((m) => [m.id, m.kind, m.from]), [['m-1', 'brief', 'chef'], ['m-3', 'followup', 'user']]);
  assert.equal(end.agents['w-3-ef56'].thread, undefined);
  const mine = end.feed.filter((l) => l.kind === 'user').map((l) => l.text);
  assert.deepEqual(mine, ['동네 빵집 소개 사이트를 만들어 주세요.', '보라에게: 친근하게 써 주세요.', '에이다에게: 한 곳 더 조사해 주세요.']);
  assert.equal(at[FOLLOWUP].chef.thinkingAt, log[0].at, '맥스는 다시 생각하기 시작하지 않는다');
});

test('끝난 일꾼에게 이어서 시키면 다시 일하고, 두 번째 보고가 남는다', async () => {
  const { at, end, phaseOf } = await run;
  assert.equal(phaseOf(at[FIRST_SETTLE].agents['w-1-ab12']), 'idle');
  assert.equal(phaseOf(at[FOLLOWUP].agents['w-1-ab12']), 'working');
  assert.equal(at[FOLLOWUP].agents['w-1-ab12'].status, 'working');
  assert.equal(end.agents['w-1-ab12'].report, '네 번째 빵집도 조사했어요.');
});

test('settle: 미션이 쉬면 타이머가 멈추고, 이어서 일하면 다시 돌고, end는 오지 않았다', async () => {
  const { at, end } = await run;
  const first = at[FIRST_SETTLE];
  assert.equal(first.settled?.text, '조사, 소개 글, 사이트를 모두 마쳤어요.');
  assert.equal(first.busySince, null);
  assert.equal(first.workMs, FIRST_SETTLE - log[0].at);
  assert.equal(at[FOLLOWUP].settled, null);
  assert.equal(at[FOLLOWUP].busySince, FOLLOWUP);
  assert.equal(end.settled?.text, '추가 조사까지 마쳤어요.');
  assert.equal(end.workMs, (FIRST_SETTLE - log[0].at) + (1795000034000 - FOLLOWUP));
  assert.equal(end.final, null);
});

test('기록의 모든 새 이벤트 종류를 한 번 이상 쓴다', () => {
  const kinds = new Set(log.map((l) => l.ev.k));
  for (const k of ['task', 'worker', 'msg', 'settle']) assert.ok(kinds.has(k as Logged['ev']['k']), k);
  const asks = log.flatMap((l) => (l.ev.k === 'ask' ? [l.ev.kind ?? 'approval'] : []));
  assert.deepEqual(asks.sort(), ['approval', 'question']);
});
