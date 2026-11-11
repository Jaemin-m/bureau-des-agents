// 세계와 그것을 그리는 쪽은 딱 하나씩만 있다: React가 다시 렌더링해도 살아남는다.
import { bus } from '../state/bus.ts';
import type { Tod } from '../state/store.ts';
import { Camera, Director } from './camera.ts';
import { Renderer } from './render.ts';
import type { TimeOfDay } from './room.ts';
import { World } from './world.ts';

export const world = new World();
export const renderer = new Renderer();
export const camera = new Camera();
export const director = new Director(camera, world);

bus.on((ev, live) => { world.apply(ev, live); director.event(ev, live); });
bus.onReset(() => { world.resetAll(); camera.wide(); });

/** 사무실 시간: 내 컴퓨터 시각(“자동”) 또는 직접 고른 시간대. */
export function timeOfDay(pref: Tod): TimeOfDay {
  if (pref !== 'auto') return pref;
  const h = new Date().getHours();
  return h >= 8 && h < 17 ? 'day' : h >= 17 && h < 21 ? 'evening' : 'night';
}
