// 사무실 카메라: 와이드 숏(모두가 일하는 모습) 또는 행동을 따라가는 클로즈업.
// 촬영 모드에서는 “감독”이 TV처럼 알아서 장면을 고른다: 문으로 들어오는 새 팀원,
// 사이트를 읽는 리서처, 팀장 책상에 놓이는 보고서…
// 그리고 주기적으로 와이드 숏을 넣어 팀 전체가 동시에 일하는 모습을 보여 준다.
import type { OfficeEvent } from '../../shared/protocol.ts';
import { BOARD, H, SPOTS, T, W } from './layout.ts';
import type { World } from './world.ts';

export class Camera {
  x = W / 2;
  y = H / 2;
  zoom = 1;
  tx = W / 2;
  ty = H / 2;
  tzoom = 1;
  /** 지금 장면을 언제까지 유지할지(초, 브라우저 시계) */
  holdUntil = 0;

  shot(x: number, y: number, zoom: number, hold: number) {
    this.tx = x;
    this.ty = y;
    this.tzoom = zoom;
    this.holdUntil = performance.now() / 1000 + hold;
  }

  wide(hold = 0) { this.shot(W / 2, H / 2, 1, hold); }

  /** 카메라를 목표 장면 쪽으로 움직인다. 움직이는 동안 true를 돌려준다. */
  update(dt: number) {
    const k = 1 - Math.exp(-dt * 2.6);
    this.x += (this.tx - this.x) * k;
    this.y += (this.ty - this.y) * k;
    this.zoom += (this.tzoom - this.zoom) * k;
    return Math.abs(this.tzoom - this.zoom) > 0.002 || Math.abs(this.tx - this.x) > 0.3 || Math.abs(this.ty - this.y) > 0.3;
  }

  /** 장면의 CSS transform(표시 크기: W*scale × H*scale). */
  css(scale: number) {
    const vw = W * scale, vh = H * scale;
    const z = this.zoom;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const ox = clamp(vw / 2 - this.x * scale * z, vw - vw * z, 0);
    const oy = clamp(vh / 2 - this.y * scale * z, vh - vh * z, 0);
    return { transform: `translate3d(${ox.toFixed(1)}px, ${oy.toFixed(1)}px, 0) scale(${z.toFixed(4)})`, zoomed: z > 1.02 };
  }
}

/** 감독: 미션에서 실제로 일어나는 일을 보고 장면을 고른다. */
export class Director {
  enabled = false;
  private cam: Camera;
  private world: World;
  private lastWho = '';
  private lastWideAt = 0;
  private lastHireShot = 0;

  constructor(cam: Camera, world: World) {
    this.cam = cam;
    this.world = world;
  }

  private now() { return performance.now() / 1000; }
  private free() { return this.now() > this.cam.holdUntil; }

  private onActor(id: string, zoom: number, hold: number) {
    const a = this.world.actors.get(id);
    if (!a) return;
    const y = a.seated && a.seat ? a.seat.y - 10 : a.y - 10;
    this.cam.shot(a.x, y, zoom, hold);
    this.lastWho = id;
  }

  event(ev: OfficeEvent, live: boolean) {
    if (!this.enabled || !live) return;
    const t = this.now();
    switch (ev.k) {
      case 'start':
        this.onActor('chef', 1.9, 2.6);
        break;
      case 'plan':
        if (this.free() || ev.items.every((i) => i.status === 'pending')) this.cam.shot(BOARD.x + BOARD.w / 2, BOARD.y + 26, 2.1, 3.2);
        break;
      case 'hire':
        if (t - this.lastHireShot > 3) { this.cam.shot(11 * T, 13 * T, 1.7, 2.6); this.lastHireShot = t; }
        break;
      case 'act':
        if (ev.who !== 'chef' && this.free() && ev.who !== this.lastWho) this.onActor(ev.who, 1.95, 2.8);
        break;
      case 'report':
        this.cam.shot(11 * T, 7 * T, 1.8, 2.6);
        break;
      case 'file':
        if (this.free()) this.cam.shot(12 * T + 8, 4 * T, 2.1, 2.2);
        break;
      case 'ask':
        this.onActor(ev.who, 2.1, 4);
        break;
      case 'end':
        this.cam.shot(SPOTS.receptionPx.x, SPOTS.receptionPx.y - 30, 1.7, 5.5);
        break;
    }
  }

  /** 주기적인 와이드 숏: 팀 전체가 동시에 일하는 모습. */
  tick() {
    if (!this.enabled || !this.free()) return;
    const t = this.now();
    if (this.cam.tzoom > 1 && t - this.lastWideAt > 9) {
      this.cam.wide(4.5);
      this.lastWideAt = t;
    }
  }
}
