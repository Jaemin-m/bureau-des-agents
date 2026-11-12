import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TaskNode, TaskRun } from '../shared/protocol.ts';
import { taskOf, taskStatus, type TaskStatus } from '../shared/tasks.ts';

const P: TaskRun = { k: 'pending' };
const DONE: TaskRun = { k: 'done', result: { summary: '' } };
const FAILED: TaskRun = { k: 'failed', why: '멈췄어요', attempts: 3 };
const CANCELLED: TaskRun = { k: 'cancelled' };
const RUNNING: TaskRun = { k: 'running', worker: 'w-1' };

const graph = (spec: Record<string, [TaskRun, string[]?]>) =>
  Object.fromEntries(Object.entries(spec).map(([key, [run, after = []]]) => [key, { after, run }]));

const cases: { name: string; tasks: ReturnType<typeof graph>; key: string; want: TaskStatus }[] = [
  { name: '먼저 할 일이 없으면 ready', tasks: graph({ a: [P] }), key: 'a', want: 'ready' },
  { name: '먼저 할 일이 끝났으면 ready', tasks: graph({ a: [DONE], b: [P, ['a']] }), key: 'b', want: 'ready' },
  { name: '먼저 할 일이 진행 중이면 waiting', tasks: graph({ a: [RUNNING], b: [P, ['a']] }), key: 'b', want: 'waiting' },
  { name: '먼저 할 일이 아직 시작 전이면 waiting', tasks: graph({ a: [P], b: [P, ['a']] }), key: 'b', want: 'waiting' },
  { name: '먼저 할 일 하나라도 덜 끝났으면 waiting', tasks: graph({ a: [DONE], b: [RUNNING], c: [P, ['a', 'b']] }), key: 'c', want: 'waiting' },
  { name: '먼저 할 일이 실패하면 blocked', tasks: graph({ a: [FAILED], b: [P, ['a']] }), key: 'b', want: 'blocked' },
  { name: '먼저 할 일이 취소되면 blocked', tasks: graph({ a: [CANCELLED], b: [P, ['a']] }), key: 'b', want: 'blocked' },
  { name: '막힘은 뒤로 번진다', tasks: graph({ a: [FAILED], b: [P, ['a']], c: [P, ['b']] }), key: 'c', want: 'blocked' },
  { name: '실패가 진행 중보다 먼저 보인다', tasks: graph({ a: [RUNNING], b: [FAILED], c: [P, ['a', 'b']] }), key: 'c', want: 'blocked' },
  { name: '아직 모르는 키를 기다리면 waiting', tasks: graph({ b: [P, ['a']] }), key: 'b', want: 'waiting' },
  { name: '고리는 blocked', tasks: graph({ a: [P, ['b']], b: [P, ['a']] }), key: 'a', want: 'blocked' },
  { name: '고리에 매달린 할 일도 blocked', tasks: graph({ a: [P, ['b']], b: [P, ['a']], c: [P, ['a']] }), key: 'c', want: 'blocked' },
  { name: '다이아몬드: 둘 다 끝나야 ready', tasks: graph({ a: [DONE], b: [DONE, ['a']], c: [DONE, ['a']], d: [P, ['b', 'c']] }), key: 'd', want: 'ready' },
  { name: '진행 중은 의존과 상관없이 running', tasks: graph({ a: [FAILED], b: [RUNNING, ['a']] }), key: 'b', want: 'running' },
  { name: '끝난 할 일은 done', tasks: graph({ a: [DONE] }), key: 'a', want: 'done' },
  { name: '실패한 할 일은 failed', tasks: graph({ a: [FAILED] }), key: 'a', want: 'failed' },
  { name: '취소한 할 일은 cancelled', tasks: graph({ a: [CANCELLED] }), key: 'a', want: 'cancelled' },
  { name: '없는 키는 waiting', tasks: graph({}), key: 'x', want: 'waiting' },
];

for (const c of cases) {
  test(`taskStatus: ${c.name}`, () => {
    assert.equal(taskStatus(c.tasks, c.key), c.want);
  });
}

test('taskStatus: 긴 사슬도 빠르게 끝난다', () => {
  const tasks: Record<string, { after: string[]; run: TaskRun }> = {};
  // 겹치는 다이아몬드 200층: 메모 없이 따라가면 2^200번 돈다
  for (let i = 0; i < 400; i++) tasks[`t${i}`] = { after: i < 2 ? [] : [`t${i - 1}`, `t${i - 2}`], run: i < 2 ? DONE : P };
  assert.equal(taskStatus(tasks, 't399'), 'waiting');
  assert.equal(taskStatus(tasks, 't2'), 'ready');
});

test('taskOf: 일꾼이 지금 맡은 할 일은 run이 그 일꾼을 가리키는 할 일', () => {
  const node = (key: string, run: TaskRun): TaskNode => ({ key, title: key, after: [], run });
  const tasks = { a: node('a', DONE), b: node('b', { k: 'running', worker: 'w-2' }), c: node('c', RUNNING) };
  assert.equal(taskOf(tasks, 'w-1')?.key, 'c');
  assert.equal(taskOf(tasks, 'w-2')?.key, 'b');
  assert.equal(taskOf(tasks, 'w-3'), undefined);
});
