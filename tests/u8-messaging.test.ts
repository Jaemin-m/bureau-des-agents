// 메시지 화면이 읽는 파생 상태: 열린 요청의 순서, 입력창의 받는 사람, 멈춘 미션을 이어서 하기, 일꾼만 멈추기.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Logged, MissionInfo } from '../shared/protocol.ts';
import { emptyStats } from '../shared/activity.ts';
import { loadStore } from './support/demo-fold.ts';

const log = readFileSync(new URL('./fixtures/scenarios/u12-many-workers.logged.jsonl', import.meta.url), 'utf8')
  .split('\n').filter(Boolean).map((l) => JSON.parse(l) as Logged);
const T0 = log[0].at;
const mission: MissionInfo = {
  id: 'u8-scenario', title: '빵집 사이트', prompt: '동네 빵집 소개 사이트를 만들어 주세요.', folder: '미션/빵집', createdAt: T0,
  workMs: 0, status: 'working', stats: emptyStats(), files: [],
};

interface Ask { requestId: string; who: string; kind: string; options?: string[]; at: number }
interface Agent { id: string; name: string; status: string; phase?: string; thread?: { id: string; kind: string; replyTo?: string }[] }
interface Store {
  asks: Record<string, Ask>; agents: Record<string, Agent>; recipient: string | null;
  mission: MissionInfo | null; busySince: number | null; replaying: boolean;
}
interface Helpers {
  openAsks(asks: Record<string, Ask>): Ask[];
  recipientOf(s: Pick<Store, 'recipient' | 'agents'>): string;
  canResume(s: Pick<Store, 'mission' | 'busySince' | 'replaying'>): boolean;
  canStopWorker(a: Agent): boolean;
}

async function fold(untilSeconds: number) {
  const mod = await loadStore<Helpers>();
  mod.useOffice.setState({ replaying: true });
  mod.useOffice.getState().resetMission(mission);
  for (const l of log) if (l.at <= T0 + untilSeconds * 1000) mod.useOffice.getState().apply(l.ev, l.at, false);
  return { ...mod, state: () => mod.useOffice.getState() as unknown as Store };
}

test('열린 요청은 먼저 온 순서로, 질문과 허락이 섞여 쌓인다', async () => {
  const { openAsks, state } = await fold(21.8);
  const list = openAsks(state().asks);
  assert.deepEqual(list.map((a) => [a.requestId, a.kind]), [['q-1', 'question'], ['r-1', 'approval']]);
  assert.deepEqual(list[0].options, ['따뜻하고 친근하게', '깔끔하고 단정하게']);
});

test('요청 키가 숫자처럼 보여도 도착 순서를 지킨다', async () => {
  const { openAsks } = await fold(0);
  const mk = (requestId: string, at: number) => ({ requestId, at, who: 'x', kind: 'approval' });
  const list = openAsks({ 2: mk('2', 2), 10: mk('10', 1) });
  assert.deepEqual(list.map((a) => a.requestId), ['10', '2']);
});

test('질문에 답한 말은 그 일꾼의 대화에 answer로 남고, 요청은 닫힌다', async () => {
  const { openAsks, state } = await fold(24.5);
  assert.deepEqual(openAsks(state().asks).map((a) => a.requestId), ['r-1']);
  const answer = state().agents['w-4-a7b8'].thread?.find((m) => m.kind === 'answer');
  assert.equal(answer?.replyTo, 'q-1');
});

test('받는 사람: 기본은 맥스, 일꾼을 고르면 그 일꾼, 사무실에 없는 일꾼이면 맥스', async () => {
  const { recipientOf, useOffice, state } = await fold(21.8);
  assert.equal(recipientOf(state()), 'chef');
  useOffice.setState({ recipient: 'w-4-a7b8' });
  assert.equal(recipientOf(state()), 'w-4-a7b8');
  useOffice.setState({ recipient: 'w-nobody' });
  assert.equal(recipientOf(state()), 'chef');
});

test('새 미션으로 바뀌면 받는 사람이 맥스로 돌아간다', async () => {
  const { useOffice, state } = await fold(21.8);
  useOffice.setState({ recipient: 'w-4-a7b8' });
  useOffice.getState().resetMission(mission);
  assert.equal(state().recipient, null);
});

test('멈춘 미션만 이어서 할 수 있다(일하는 중이거나 다시 보기 중이면 안 된다)', async () => {
  const { canResume } = await fold(0);
  const stopped = { ...mission, status: 'stopped' as const };
  assert.equal(canResume({ mission: stopped, busySince: null, replaying: false }), true);
  assert.equal(canResume({ mission: { ...mission, status: 'done' }, busySince: null, replaying: false }), false);
  assert.equal(canResume({ mission: stopped, busySince: 1, replaying: false }), false);
  assert.equal(canResume({ mission: stopped, busySince: null, replaying: true }), false);
  assert.equal(canResume({ mission: null, busySince: null, replaying: false }), false);
});

test('일꾼만 멈추기는 일하거나 기다리는 일꾼에게만 열린다', async () => {
  const { canStopWorker } = await fold(0);
  const at = (phase?: string, status = 'working') => ({ id: 'a', name: 'a', phase, status });
  for (const p of ['provisioning', 'starting', 'working', 'blocked']) assert.equal(canStopWorker(at(p)), true, p);
  for (const p of ['idle', 'stopping', 'stopped', 'failed', 'retired']) assert.equal(canStopWorker(at(p)), false, p);
  assert.equal(canStopWorker(at(undefined, 'working')), true, '옛 기록: 일하는 중');
  assert.equal(canStopWorker(at(undefined, 'done')), false, '옛 기록: 끝남');
});
