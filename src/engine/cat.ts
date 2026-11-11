// 사무실 고양이 픽셀: 주황 눈의 검은 고양이(사무실 대표 색). 돌아다니다 앉기도 하고,
// 소파에서 오래 낮잠을 잔다. 클릭하면 야옹 한다.
import { findPath, type Tile } from './path.ts';
import { g2d, makeCanvas, outline, rect, px } from './pixels.ts';
import { T, tileFeet } from './layout.ts';

type CatPose = 'walk' | 'sit' | 'sleep';

const BODY = '#26222f';
const RIM = '#4a4458';
const EYE = '#ff8a3d';

function build(pose: CatPose, frame: number, right: boolean): HTMLCanvasElement {
  const c = makeCanvas(16, 12);
  const g = g2d(c);
  if (pose === 'sleep') {
    // 꼬리를 감고 동그랗게 웅크린 모습
    rect(g, 3, 6, 10, 4, BODY);
    rect(g, 4, 5, 8, 1, BODY);
    rect(g, 4, 5, 6, 1, RIM);
    rect(g, 10, 4, 3, 3, BODY);
    px(g, 10, 3, BODY);
    px(g, 12, 3, BODY);
    rect(g, 11, 5, 1, 1, '#120f17');
    rect(g, 2, 8, 2, 2, BODY);
  } else if (pose === 'sit') {
    rect(g, 6, 4, 5, 6, BODY);
    rect(g, 5, 8, 7, 2, BODY);
    rect(g, 6, 1, 5, 4, BODY);
    px(g, 6, 0, BODY);
    px(g, 10, 0, BODY);
    hlineRim(g, 6, 1, 5);
    px(g, 7, 2, EYE);
    px(g, 9, 2, EYE);
    px(g, 8, 3, '#ff9fb3');
    rect(g, 11, 8, 3, 1, BODY);
    px(g, 13, 7, BODY);
  } else {
    // 옆모습, 오른쪽을 본다
    const f = frame % 2;
    rect(g, 3, 4, 8, 4, BODY);
    hlineRim(g, 3, 4, 8);
    rect(g, 10, 2, 4, 4, BODY);
    px(g, 10, 1, BODY);
    px(g, 13, 1, BODY);
    px(g, 12, 3, EYE);
    px(g, 13, 4, '#ff9fb3');
    // 꼿꼿이 세운 꼬리
    px(g, 2, 3, BODY);
    px(g, 1, 2, BODY);
    px(g, 1, 1, BODY);
    // 다리
    for (const [x, up] of [[4, f], [6, 1 - f], [9, f], [11, 1 - f]] as [number, number][]) rect(g, x, 8, 1, up ? 1 : 2, BODY);
  }
  outline(c, '#0b0910');
  if (!right && pose === 'walk') {
    const m = makeCanvas(16, 12);
    const mg = g2d(m);
    mg.translate(16, 0);
    mg.scale(-1, 1);
    mg.drawImage(c, 0, 0);
    return m;
  }
  return c;
}

function hlineRim(g: CanvasRenderingContext2D, x: number, y: number, w: number) { rect(g, x, y, w, 1, RIM); }

const cache = new Map<string, HTMLCanvasElement>();
function sprite(pose: CatPose, frame: number, right: boolean) {
  const k = `${pose}|${frame}|${right}`;
  let c = cache.get(k);
  if (!c) { c = build(pose, frame, right); cache.set(k, c); }
  return c;
}

/** 소파(잠자는 곳)와 즐겨 어슬렁거리는 자리. */
const SOFA = { x: 3 * T + 4, y: 14 * T + 4, from: [3, 13] as Tile };
const HAUNTS: Tile[] = [[9, 10], [12, 10], [7, 13], [14, 13], [17, 13], [10, 9], [3, 9], [18, 9], [8, 6]];

export class Cat {
  x = SOFA.x;
  y = SOFA.y;
  right = true;
  pose: CatPose = 'sleep';
  private path: { x: number; y: number }[] = [];
  private until = 8;
  private t = 0;
  private toSofa = false;
  heartUntil = 0;

  get tile(): Tile { return [Math.floor(this.x / T), Math.floor((this.y - 2) / T)]; }

  update(dt: number, time: number, grid: boolean[][], onZ: (x: number, y: number) => void) {
    this.t += dt;
    if (this.path.length) {
      const p = this.path[0];
      const dx = p.x - this.x, dy = p.y - this.y;
      const d = Math.hypot(dx, dy);
      const step = 22 * dt;
      if (Math.abs(dx) > 0.5) this.right = dx > 0;
      if (d <= step) { this.x = p.x; this.y = p.y; this.path.shift(); }
      else { this.x += (dx / d) * step; this.y += (dy / d) * step; }
      this.pose = 'walk';
      if (!this.path.length) {
        this.pose = this.toSofa ? 'sleep' : 'sit';
        this.until = time + (this.toSofa ? 25 + Math.random() * 25 : 4 + Math.random() * 6);
      }
      return true;
    }
    if (this.pose === 'sleep' && Math.floor(this.t * 0.8) !== Math.floor((this.t - dt) * 0.8)) onZ(this.x + 6, this.y - 10);
    if (time < this.until) return false;
    // 이동: 사무실 구석으로, 또는 낮잠 자러 소파로
    this.toSofa = Math.random() < 0.3;
    const target = this.toSofa ? SOFA.from : HAUNTS[Math.floor(Math.random() * HAUNTS.length)];
    const tiles = findPath(grid, this.tile, target);
    if (!tiles) { this.until = time + 3; return false; }
    this.path = tiles.map(tileFeet).map((p) => ({ x: p.x, y: p.y - 2 }));
    if (this.toSofa) this.path.push({ x: SOFA.x, y: SOFA.y });
    return true;
  }

  /** 클릭: 멈춰서 쳐다보고 야옹 한다. */
  pet(time: number) {
    this.path = [];
    this.pose = 'sit';
    this.until = time + 3;
    this.heartUntil = time + 1.2;
  }

  get frame() { return Math.floor(this.t * 6) % 2; }

  /** 소파 위에서는 앞에 그린다(아니면 등받이에 가려진다). */
  get sortY() { return this.pose === 'sleep' && !this.path.length && Math.abs(this.x - SOFA.x) < 2 ? 14 * T + 15 : this.y; }

  draw(g: CanvasRenderingContext2D) {
    const s = sprite(this.pose, this.frame, this.right);
    g.fillStyle = 'rgba(8,6,16,0.3)';
    g.fillRect(Math.round(this.x) - 5, Math.round(this.y) - 1, 10, 2);
    g.drawImage(s, Math.round(this.x) - 8, Math.round(this.y) - 11);
  }

  /** 클릭할 수 있는 영역(사무실 픽셀 단위). */
  hit(x: number, y: number) { return Math.abs(x - this.x) < 8 && y > this.y - 12 && y < this.y + 2; }
}
