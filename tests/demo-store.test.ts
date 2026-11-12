import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { FOLDED_KEYS, foldDemo, UI_KEYS } from './support/demo-fold.ts';

const SNAPSHOT = new URL('./fixtures/demo-store-snapshot.json', import.meta.url);

test('데모 미션을 스토어에 접으면 스냅샷과 같다', async () => {
  const { snapshot } = await foldDemo();
  assert.deepEqual(snapshot, JSON.parse(readFileSync(SNAPSHOT, 'utf8')));
});

test('스토어의 모든 키는 이벤트 상태 또는 화면 설정으로 분류돼 있다', async () => {
  const { keys } = await foldDemo();
  const known = new Set<string>([...FOLDED_KEYS, ...UI_KEYS]);
  const unclassified = keys.filter((k) => !known.has(k));
  assert.deepEqual(unclassified, [], '새 스토어 키: tests/support/demo-fold.ts의 FOLDED_KEYS 또는 UI_KEYS에 넣고 스냅샷을 다시 만드세요');
});

test('데모는 실제로 상태를 채운다(빈 스냅샷으로 통과하지 못한다)', async () => {
  const { snapshot } = await foldDemo();
  const s = snapshot as { order: string[]; feed: unknown[]; files: unknown[]; final: { text: string } | null };
  assert.ok(s.order.length > 0 && s.feed.length > 0 && s.files.length > 0 && s.final?.text);
});
