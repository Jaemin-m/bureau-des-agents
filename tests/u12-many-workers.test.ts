// 손으로 쓴 시나리오(일꾼 열 명, 두 CLI, 할 일 여섯 개, 질문 하나, 허락 하나, 쉬는 일꾼, settle)를
// 스토어와 사무실 세계(자리)에 함께 접어, 칠판과 자리가 맞는지 본다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Logged, MissionInfo, OfficeEvent } from '../shared/protocol.ts';
import { emptyStats } from '../shared/activity.ts';
import { taskStatus, type TaskGraph } from '../shared/tasks.ts';
import { dagRows } from '../src/engine/dag.ts';
import { loadStore } from './support/demo-fold.ts';

const log = readFileSync(new URL('./fixtures/scenarios/u12-many-workers.logged.jsonl', import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l) as Logged);
const T0 = log[0].at;
const mission: MissionInfo = {
  id: 'u12-scenario', title: '빵집 사이트', prompt: '동네 빵집 소개 사이트를 만들어 주세요.', folder: '미션/빵집', createdAt: T0,
  workMs: 0, status: 'working', stats: emptyStats(), files: [],
};

interface Agent { id: string; name: string; role: string; agent?: string; phase?: string; block?: string; parked?: boolean; thread?: unknown[] }
interface View { agents: Record<string, Agent>; order: string[]; tasks: TaskGraph; asks: Record<string, { who: string; kind: string }>; settled: unknown; stats: { agents: number } }
type Helpers = { agentKindOf(a: Agent): string; phaseOf(a: Agent): string };

interface Actor { id: string; seat: { id: string; lounge?: boolean } | null; standSpot: [number, number] | null; stacked: boolean; seated: boolean; kind: string | null; phase: string | null }
interface WorldLike { actors: Map<string, Actor>; stackCount: number; dag: { key: string }[]; apply(ev: OfficeEvent, live: boolean): void }

async function loadWorld(): Promise<WorldLike> {
  const url = new URL('../src/engine/world.ts', import.meta.url).href;
  const { World } = (await import(url)) as { World: new () => WorldLike };
  return new World();
}

const KEYS = ['agents', 'order', 'tasks', 'asks', 'settled', 'stats'] as const;
const snap = (st: Record<string, unknown>) => structuredClone(Object.fromEntries(KEYS.map((k) => [k, st[k]]))) as unknown as View;
const where = (a: Actor) => (a.stacked ? 'stack' : a.seat?.lounge ? 'sofa' : a.seat ? 'desk' : a.standSpot ? 'floor' : 'none');

/** 시각(초)까지의 이벤트를 접은 상태를 스토어와 세계에서 찍어 둔다. */
async function foldTo(seconds: number[]) {
  const { useOffice, agentKindOf, phaseOf } = await loadStore<Helpers>();
  useOffice.setState({ replaying: true });
  useOffice.getState().resetMission(mission);
  const world = await loadWorld();
  const out: Record<number, { view: View; places: Record<string, string>; actors: Actor[] }> = {};
  for (let i = 0; i < log.length; i++) {
    useOffice.getState().apply(log[i].ev, log[i].at, false);
    world.apply(log[i].ev, false);
    for (const s of seconds) {
      const lastOfWindow = log[i].at <= T0 + s * 1000 && (i + 1 === log.length || log[i + 1].at > T0 + s * 1000);
      if (lastOfWindow) out[s] = { view: snap(useOffice.getState()), places: Object.fromEntries([...world.actors.values()].filter((a) => a.id !== 'chef').map((a) => [a.id, where(a)])), actors: [...world.actors.values()].map((a) => ({ ...a })) };
    }
  }
  return { out, agentKindOf, phaseOf, world, end: snap(useOffice.getState()) };
}

const MANY = 10.5;
const ASKS = 21.6;
const END = 46;
const run = foldTo([MANY, ASKS, END]);
const ids = (view: View, pick: (a: Agent) => boolean) => view.order.filter((id) => pick(view.agents[id]));

test('기록: 일꾼 열 명은 claude와 codex이고 할 일은 여섯 개다', async () => {
  const { end, agentKindOf } = await run;
  assert.equal(end.order.length, 10);
  assert.equal(end.stats.agents, 10);
  assert.deepEqual([...new Set(end.order.map((id) => agentKindOf(end.agents[id])))].sort(), ['claude', 'codex']);
  assert.equal(Object.keys(end.tasks).length, 6);
  assert.ok(end.settled);
  const kinds = new Set(log.map((l) => l.ev.k));
  for (const k of ['task', 'worker', 'msg', 'settle', 'ask', 'ask_done']) assert.ok(kinds.has(k as Logged['ev']['k']), k);
});

test('여럿이 일하는 때: 책상에 앉아 일하는 일꾼이 여섯이고 직무별 자기 구역에 앉는다', async () => {
  const { out, phaseOf } = await run;
  const { view, places } = out[MANY];
  const working = ids(view, (a) => phaseOf(a) === 'working');
  assert.equal(working.length, 6);
  for (const id of working) assert.equal(places[id], 'desk', id);
  const research = ids(view, (a) => a.role === 'recherche');
  assert.equal(research.length, 4);
});

test('질문과 허락이 함께 열려 있고, 쉬는 일꾼은 소파나 커피 머신 앞에 있다', async () => {
  const { out, phaseOf } = await run;
  const { view, places, actors } = out[ASKS];
  assert.deepEqual(Object.keys(view.asks), ['q-1', 'r-1']);
  assert.deepEqual(Object.values(view.asks).map((a) => a.kind), ['question', 'approval']);
  const blocked = ids(view, (a) => phaseOf(a) === 'blocked');
  assert.deepEqual(blocked.map((id) => view.agents[id].block).sort(), ['approval', 'question']);
  for (const id of blocked) assert.equal(places[id], 'desk', '막혀도 책상에 앉아 있다');
  const resting = ids(view, (a) => phaseOf(a) === 'idle');
  assert.equal(resting.length, 5);
  assert.ok(resting.some((id) => view.agents[id].parked), '잠든 일꾼이 하나 있다');
  for (const id of resting) assert.ok(places[id] === 'sofa' || places[id] === 'floor', `${id} ${places[id]}`);
  for (const a of actors.filter((x) => x.id !== 'chef')) assert.ok(a.kind === 'claude' || a.kind === 'codex');
});

test('settle: 일꾼은 모두 쉬고, 걸어 나가지 않은 채 소파·커피 머신 앞 또는 책상에 남는다', async () => {
  const { out, phaseOf, world } = await run;
  const { view, places } = out[END];
  assert.ok(view.settled);
  for (const id of view.order) {
    assert.equal(phaseOf(view.agents[id]), 'idle', id);
    assert.ok(['sofa', 'floor', 'desk'].includes(places[id]), `${id} ${places[id]}`);
  }
  assert.equal(world.actors.size, 11, '맥스와 일꾼 열 명');
  assert.equal(world.stackCount, 0);
  const lounge = view.order.filter((id) => places[id] === 'sofa' || places[id] === 'floor');
  assert.equal(lounge.length, 8, '쉬는 자리는 소파 셋과 서는 자리 다섯');
});

test('할 일 그래프: 위상 순서로 늘어서고 끝에는 모두 done이다', async () => {
  const { end, world } = await run;
  const rows = dagRows(end.tasks as never);
  assert.equal(rows.length, 6);
  for (const r of rows) assert.equal(taskStatus(end.tasks, r.key), 'done');
  assert.deepEqual(world.dag.map((r) => r.key), rows.map((r) => r.key), '칠판이 같은 줄을 쓴다');
  const depth = Object.fromEntries(rows.map((r) => [r.key, r.depth]));
  assert.deepEqual(depth, { market: 0, compete: 0, brand: 1, design: 1, site: 2, qa: 3 });
});

test('자리가 모자라면 더미에 쌓이고 맨 위 한 명만 보인다', async () => {
  const world = await loadWorld();
  for (let i = 0; i < 40; i++) {
    world.apply({ k: 'hire', id: `w-${i}`, role: 'recherche', type: 'chercheur', name: `일꾼${i}`, task: '일', prompt: '일', agent: 'claude' }, false);
    world.apply({ k: 'worker', id: `w-${i}`, phase: 'working' }, false);
  }
  const all = [...world.actors.values()].filter((a) => a.id !== 'chef');
  assert.equal(all.length, 40);
  const stacked = all.filter((a) => a.stacked);
  assert.equal(world.stackCount, stacked.length);
  assert.ok(stacked.length > 0 && stacked.length < 40);
  assert.equal(all.filter((a) => !a.stacked && a.seat).length, 16, '책상 열여섯이 다 찼다');
  assert.equal(stacked.filter((a) => (a as unknown as { alpha: number }).alpha > 0).length, 1);
  world.apply({ k: 'worker', id: 'w-0', phase: 'idle' }, false);
  assert.ok(all.find((a) => a.id === 'w-0')!.seat?.lounge, '쉬는 일꾼은 소파로 간다');
  assert.equal(world.stackCount, stacked.length - 1, '책상 하나가 비면 더미에서 한 명이 앉는다');
});

test('옛 기록의 팀원은 새 배지도 새 자리 규칙도 받지 않는다', async () => {
  const world = await loadWorld();
  world.apply({ k: 'hire', id: 'a1', role: 'code', type: 'developpeur', name: '에이다', task: '일', prompt: '일' }, false);
  const a = world.actors.get('a1')!;
  assert.equal(a.kind, null);
  assert.equal(a.phase, null);
  assert.equal(where(a), 'desk');
  world.apply({ k: 'leave', who: 'a1', ok: true, tokens: 0, tools: 0, ms: 0 }, false);
  assert.ok(!world.actors.has('a1'));
});
