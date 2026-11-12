import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workingAt } from '../server/bureau.ts';

test('턴이 끝난 바로 그 밀리초에 쓴 파일도 그 일꾼의 것이다', () => {
  const spans = new Map<string, [number, number][]>([['w-4', [[1000, 1500]]], ['w-7', [[1500, 2267]]]]);
  assert.equal(workingAt(spans, 2267.0396), 'w-7');
  assert.equal(workingAt(spans, 2268), undefined);
});

test('두 일꾼이 겹쳐 일하던 때의 파일은 누구 것인지 정하지 않는다', () => {
  const spans = new Map<string, [number, number][]>([['w-1', [[0, 100]]], ['w-2', [[50, 150]]]]);
  assert.equal(workingAt(spans, 75.5), undefined);
});
