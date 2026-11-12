// 같은 새 이벤트 기록을 사무실 세계(로봇)에 애니메이션과 함께 돌린다: 손을 든 로봇, 두 번 보고하는 일꾼.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Logged, OfficeEvent } from '../shared/protocol.ts';

interface Actor { asks: number; seated: boolean; left: boolean; busy: boolean }
interface World { actors: Map<string, Actor>; inbox: number; apply(ev: OfficeEvent, live: boolean): void; update(dt: number): boolean }

const LOG = new URL('./fixtures/scenarios/u1-new-kinds.logged.jsonl', import.meta.url);
const log = readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Logged);
const worldUrl = new URL('../src/engine/world.ts', import.meta.url).href;

async function play(live: boolean, stopAt = Infinity) {
  const { World } = (await import(worldUrl)) as { World: new () => World };
  const w = new World();
  for (let i = 0; i < log.length && log[i].at <= stopAt; i++) {
    w.apply(log[i].ev, live);
    // 다음 이벤트까지 실제 간격만큼(최대 8초) 세계를 돌린다
    const gap = Math.min(8000, (log[i + 1]?.at ?? log[i].at + 8000) - log[i].at);
    if (live) for (let t = 0; t < gap; t += 100) w.update(0.1);
  }
  return w;
}

test('세계: ask_done은 그 요청을 한 로봇의 손만 내린다', async () => {
  const w = await play(true, 1795000008100);
  assert.equal(w.actors.get('w-2-cd34')?.asks, 0, '질문한 보라는 답을 받았다');
  assert.equal(w.actors.get('w-1-ab12')?.asks, 1, '에이다의 승인 요청은 아직 열려 있다');
});

for (const live of [true, false]) {
  test(`세계(${live ? '애니메이션' : '바로 맞추기'}): 일꾼은 보고하고 나서도 자리에 남고, 이어서 시키면 또 보고한다`, async () => {
    const w = await play(live);
    for (const id of ['w-1-ab12', 'w-2-cd34', 'w-3-ef56']) {
      const a = w.actors.get(id);
      assert.ok(a && !a.left && !a.busy, `${id} 사무실에 있다`);
      assert.ok(a.seated, `${id} 자기 책상에 돌아가 앉았다`);
      assert.equal(a.asks, 0, id);
    }
    assert.equal(w.inbox, 4, '보고서 넷: 세 명 + 에이다의 두 번째 보고');
  });
}
