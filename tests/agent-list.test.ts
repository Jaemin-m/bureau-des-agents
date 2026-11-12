// 안내 글에는 이 컴퓨터에서 실제로 쓸 수 있는 에이전트만 나온다(hello.agents에서 found인 것).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentList } from '../src/engine/kinds.ts';

test('깔려 있고 지원하는 CLI만 이름을 보여 준다', () => {
  assert.equal(agentList([{ kind: 'claude', found: true, version: '2.1' }, { kind: 'codex', found: true }, { kind: 'gemini', found: false }]), '(Claude Code, Codex)');
});

test('찾지 못한 CLI는 빠진다', () => {
  assert.equal(agentList([{ kind: 'claude', found: true }, { kind: 'codex', found: false }, { kind: 'gemini', found: false }]), '(Claude Code)');
});

test('아직 모르거나(데모, 옛 서버) 하나도 없으면 빈 글이라 이름을 지어내지 않는다', () => {
  assert.equal(agentList([]), '');
  assert.equal(agentList([{ kind: 'claude', found: false }]), '');
});
