// 일꾼의 자리(seatWorkers)와 칠판 줄(dagRows, boardRows)은 화면 없이 표로 검사한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Role, TaskNode, TaskRun, WorkerPhase } from '../shared/protocol.ts';
import { boardRows, dagCounts, dagRows, summaryParts } from '../src/engine/dag.ts';
import { LOUNGE_SEATS, LOUNGE_STANDS, SEATS, SPOTS } from '../src/engine/layout.ts';
import { seatWorkers, spotKey, type Roster } from '../src/engine/seating.ts';

const w = (id: string, role: Role, phase: WorkerPhase, extra: Partial<Roster> = {}): Roster => ({ id, role, phase, ...extra });
const placeOf = (spots: ReturnType<typeof seatWorkers>, id: string) => spotKey(spots.get(id)!);
const isDesk = (key: string) => key.startsWith('seat:seat-desk-');
const isLounge = (key: string) => key.startsWith('seat:seat-sofa-') || LOUNGE_STANDS.some((t) => key === `floor:${t.join(',')}`);
const deskRole = (key: string) => SEATS.find((s) => `seat:${s.id}` === key)?.role;

test('일하는 일꾼은 자기 구역 책상에 앉는다', () => {
  const spots = seatWorkers([w('a', 'code', 'working'), w('b', 'design', 'starting'), w('c', 'analyse', 'blocked')]);
  assert.equal(deskRole(placeOf(spots, 'a')), 'code');
  assert.equal(deskRole(placeOf(spots, 'b')), 'design');
  assert.equal(deskRole(placeOf(spots, 'c')), 'analyse');
});

test('자기 구역 책상이 모자라면 빈 책상 아무 데나, 그것도 없으면 바닥 자리', () => {
  const codeDesks = SEATS.filter((s) => s.role === 'code').length;
  const team = Array.from({ length: codeDesks + 1 }, (_, i) => w(`c${i}`, 'code', 'working'));
  const spots = seatWorkers(team);
  assert.equal(team.filter((x) => deskRole(placeOf(spots, x.id)) === 'code').length, codeDesks);
  assert.ok(isDesk(placeOf(spots, `c${codeDesks}`)), '다른 구역의 빈 책상');

  const crowd = Array.from({ length: SEATS.length + 2 }, (_, i) => w(`x${i}`, 'recherche', 'working'));
  const overflow = new Set(SPOTS.overflow.map((t) => `floor:${t.join(',')}`));
  const crowded = seatWorkers(crowd);
  assert.equal(crowd.filter((x) => isDesk(placeOf(crowded, x.id))).length, SEATS.length);
  assert.ok(overflow.has(placeOf(crowded, `x${SEATS.length}`)));
});

test('쉬는 일꾼(idle, parked, stopped, failed)은 소파와 커피 머신 앞으로 간다', () => {
  const spots = seatWorkers([
    w('i', 'code', 'idle'), w('p', 'code', 'idle', { parked: true }), w('s', 'design', 'stopped'), w('f', 'analyse', 'failed'),
  ]);
  for (const id of ['i', 'p', 's', 'f']) assert.ok(isLounge(placeOf(spots, id)), id);
  const keys = ['i', 'p', 's', 'f'].map((id) => placeOf(spots, id));
  assert.equal(new Set(keys).size, 4, '같은 자리에 둘이 서지 않는다');
});

test('쉬는 일꾼이 책상을 먼저 내놓는다: 일하는 일꾼이 먼저 자리를 받는다', () => {
  const lounge = LOUNGE_SEATS.length + LOUNGE_STANDS.length;
  const resters = Array.from({ length: lounge }, (_, i) => w(`r${i}`, 'code', 'idle'));
  const codeDesk = SEATS.find((s) => s.role === 'code')!;
  const holder = w('holder', 'code', 'idle', { prev: `seat:${codeDesk.id}` });
  const before = seatWorkers([...resters, holder]);
  assert.equal(placeOf(before, 'holder'), `seat:${codeDesk.id}`, '쉬는 자리가 다 찼으면 책상에 앉아 쉰다');

  const codeDesks = SEATS.filter((s) => s.role === 'code');
  const busy = codeDesks.map((s, i) => w(`b${i}`, 'code', 'working', i === 0 ? {} : { prev: `seat:${s.id}` }));
  const after = seatWorkers([...resters, holder, ...busy]);
  assert.equal(deskRole(placeOf(after, 'b0')), 'code');
  assert.equal(codeDesks.filter((s) => [...after.values()].some((p) => spotKey(p) === `seat:${s.id}`)).length, codeDesks.length);
  assert.ok(!isDesk(placeOf(after, 'holder')) || deskRole(placeOf(after, 'holder')) !== 'code', '일하는 사람이 코드 구역 책상을 모두 가졌다');
});

test('이미 있는 자리는 새로 온 사람 때문에 바뀌지 않는다', () => {
  const first = seatWorkers([w('a', 'recherche', 'working'), w('b', 'recherche', 'working')]);
  const a = placeOf(first, 'a'), b = placeOf(first, 'b');
  const later = seatWorkers([w('n', 'recherche', 'working'), w('a', 'recherche', 'working', { prev: a }), w('b', 'recherche', 'working', { prev: b })]);
  assert.equal(placeOf(later, 'a'), a);
  assert.equal(placeOf(later, 'b'), b);
  assert.notEqual(placeOf(later, 'n'), a);
  assert.notEqual(placeOf(later, 'n'), b);
  // 쉬는 자리에 앉아 있으면 그대로
  const rest = seatWorkers([w('r', 'code', 'idle')]);
  assert.deepEqual(seatWorkers([w('r', 'code', 'idle', { prev: placeOf(rest, 'r') })]), rest);
});

test('다시 일하기 시작하면 책상으로 돌아간다', () => {
  const idle = seatWorkers([w('a', 'design', 'idle')]);
  const back = seatWorkers([w('a', 'design', 'working', { prev: placeOf(idle, 'a') })]);
  assert.equal(deskRole(placeOf(back, 'a')), 'design');
});

test('옛 방식으로 앉은 로봇의 자리는 건드리지 않는다', () => {
  const desk = SEATS.find((s) => s.role === 'code')!;
  const spots = seatWorkers([w('a', 'code', 'working')], new Set([`seat:${desk.id}`]));
  assert.notEqual(placeOf(spots, 'a'), `seat:${desk.id}`);
});

test('자리가 모자라면 쌓인다: 쌓인 사람도 자리를 하나씩 가진 사람과 겹치지 않는다', () => {
  const total = SEATS.length + SPOTS.overflow.length;
  const crowd = Array.from({ length: total + 5 }, (_, i) => w(`x${i}`, 'recherche', 'working'));
  const spots = seatWorkers(crowd);
  const stacked = crowd.filter((x) => spots.get(x.id)!.k === 'stack');
  assert.equal(stacked.length, 5);
  const real = crowd.filter((x) => spots.get(x.id)!.k !== 'stack').map((x) => placeOf(spots, x.id));
  assert.equal(new Set(real).size, total);
});

// ── 칠판 ──
const node = (key: string, after: string[], run: TaskRun): TaskNode => ({ key, title: key, after, run });
const P: TaskRun = { k: 'pending' };
const RUN: TaskRun = { k: 'running', worker: 'w' };
const DONE: TaskRun = { k: 'done', result: { summary: '' } };
const graph = (...nodes: TaskNode[]) => Object.fromEntries(nodes.map((n) => [n.key, n]));

test('칠판 줄: 위상 순서이고 깊이는 가장 긴 선행 사슬이다', () => {
  const g = graph(node('site', ['copy', 'design'], P), node('copy', ['market'], P), node('design', ['market', 'compete'], P), node('market', [], DONE), node('compete', [], DONE));
  const rows = dagRows(g);
  const order = rows.map((r) => r.key);
  for (const r of rows) for (const d of g[r.key].after) assert.ok(order.indexOf(d) < order.indexOf(r.key), `${d} → ${r.key}`);
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.key, r.depth])), { market: 0, compete: 0, copy: 1, design: 1, site: 2 });
});

test('칠판 줄: 고리가 있어도 끝나고, 모르는 선행 키는 무시한다', () => {
  const rows = dagRows(graph(node('a', ['b'], P), node('b', ['a'], P), node('c', ['ghost'], P)));
  assert.deepEqual(rows.map((r) => r.key).sort(), ['a', 'b', 'c']);
  assert.equal(rows.find((r) => r.key === 'c')!.depth, 0);
});

test('칠판은 최대 네 줄: 일하는 일, 곧 시작할 일을 먼저 고르고 순서는 위상 순서', () => {
  const rows = dagRows(graph(
    node('d1', [], DONE), node('d2', ['d1'], DONE), node('d3', ['d2'], DONE), node('r1', ['d3'], RUN), node('w1', ['r1'], P), node('w2', ['w1'], P),
  ));
  const picked = boardRows(rows).map((r) => r.key);
  assert.equal(picked.length, 4);
  assert.ok(picked.includes('r1') && picked.includes('w1'));
  assert.deepEqual(picked, [...picked].sort((a, b) => rows.findIndex((r) => r.key === a) - rows.findIndex((r) => r.key === b)));
  assert.deepEqual(boardRows(rows.slice(0, 2)).map((r) => r.key), ['d1', 'd2']);
});

test('칠판 요약: 대기 · 완료가 기본이고 진행과 실패는 있을 때만 붙는다', () => {
  const counts = dagCounts(dagRows(graph(node('a', [], DONE), node('b', [], DONE), node('c', ['a'], RUN), node('d', ['c'], P), node('e', ['d'], P), node('f', [], { k: 'failed', why: 'x', attempts: 1 }))));
  assert.deepEqual(summaryParts(counts), { base: '대기 2 · 완료 2', running: '진행 1 · ', failed: ' · 실패 1' });
  assert.deepEqual(summaryParts(dagCounts(dagRows(graph(node('a', [], DONE))))), { base: '대기 0 · 완료 1', running: '', failed: '' });
});
