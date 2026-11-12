import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { FOLDED_KEYS, foldDemo, loadStore, NEW_FOLDED_KEYS, UI_KEYS } from './support/demo-fold.ts';

const SNAPSHOT = new URL('./fixtures/demo-store-snapshot.json', import.meta.url);

test('데모 미션을 스토어에 접으면 스냅샷과 같다', async () => {
  const { snapshot } = await foldDemo();
  assert.deepEqual(snapshot, JSON.parse(readFileSync(SNAPSHOT, 'utf8')));
});

test('스토어의 모든 키는 이벤트 상태 또는 화면 설정으로 분류돼 있다', async () => {
  const { keys } = await foldDemo();
  const known = new Set<string>([...FOLDED_KEYS, ...Object.keys(NEW_FOLDED_KEYS), ...UI_KEYS]);
  const unclassified = keys.filter((k) => !known.has(k));
  assert.deepEqual(unclassified, [], '새 스토어 키: tests/support/demo-fold.ts의 FOLDED_KEYS, NEW_FOLDED_KEYS, UI_KEYS 중 하나에 넣으세요');
});

test('옛 기록(데모)은 새 상태 키를 처음 값 그대로 둔다', async () => {
  const { added } = await foldDemo();
  assert.deepEqual(added, NEW_FOLDED_KEYS);
});

test('데모는 실제로 상태를 채운다(빈 스냅샷으로 통과하지 못한다)', async () => {
  const { snapshot } = await foldDemo();
  const s = snapshot as { order: string[]; feed: unknown[]; files: unknown[]; final: { text: string } | null };
  assert.ok(s.order.length > 0 && s.feed.length > 0 && s.files.length > 0 && s.final?.text);
});

test('옛 기록의 팀원은 모두 claude이고, 단계는 예전 status에서 읽는다', async () => {
  const { snapshot } = await foldDemo();
  type A = { status: string };
  const { agentKindOf, phaseOf } = await loadStore<{ agentKindOf(a: A): string; phaseOf(a: A): string }>();
  const agents = Object.values((snapshot as { agents: Record<string, A> }).agents);
  assert.ok(agents.length > 0);
  assert.deepEqual(new Set(agents.map(agentKindOf)), new Set(['claude']));
  assert.deepEqual(new Set(agents.map(phaseOf)), new Set(['retired']));
});
