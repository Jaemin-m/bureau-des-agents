// 픽셀 아트 도구 상자: 아주 작은 캔버스에 픽셀 하나하나 그린 뒤 흐림 없이 확대한다.
// 사무실 전체(가구, 로봇, 아이콘)를 여기서 코드로 그린다. 외부 이미지는 하나도 없다.

export type G = CanvasRenderingContext2D;

export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}

export function g2d(c: HTMLCanvasElement): G {
  const g = c.getContext('2d', { willReadFrequently: false })!;
  g.imageSmoothingEnabled = false;
  return g;
}

export function rect(g: G, x: number, y: number, w: number, h: number, color: string) {
  g.fillStyle = color;
  g.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

export function px(g: G, x: number, y: number, color: string) {
  g.fillStyle = color;
  g.fillRect(Math.round(x), Math.round(y), 1, 1);
}

/** 1픽셀 가로선 또는 세로선. */
export function hline(g: G, x: number, y: number, w: number, color: string) { rect(g, x, y, w, 1, color); }
export function vline(g: G, x: number, y: number, h: number, color: string) { rect(g, x, y, 1, h, color); }

/** 불투명한 부분 둘레에 1픽셀 윤곽선을 두른다(“픽셀 아트” 실루엣). */
export function outline(c: HTMLCanvasElement, color: string, opts: { diagonal?: boolean; skipBottom?: boolean } = {}) {
  const g = c.getContext('2d')!;
  const w = c.width, h = c.height;
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && d[(y * w + x) * 4 + 3] > 40;
  const out: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (solid(x, y)) continue;
      let hit = solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || (!opts.skipBottom && solid(x, y + 1));
      if (!hit && opts.diagonal) hit = solid(x - 1, y - 1) || solid(x + 1, y - 1) || solid(x - 1, y + 1) || solid(x + 1, y + 1);
      if (hit) out.push(x, y);
    }
  }
  g.fillStyle = color;
  for (let i = 0; i < out.length; i += 2) g.fillRect(out[i], out[i + 1], 1, 1);
  return c;
}

/**
 * 글자로 적은 스프라이트: 픽셀 한 줄에 한 행, 픽셀 하나에 글자 하나.
 * “.”이나 공백은 투명, 나머지 글자는 팔레트 색을 가리킨다.
 */
export function fromRows(rows: string[], pal: Record<string, string>): HTMLCanvasElement {
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const c = makeCanvas(w, h);
  const g = g2d(c);
  for (let y = 0; y < h; y++) {
    const r = rows[y];
    for (let x = 0; x < r.length; x++) {
      const ch = r[x];
      if (ch === '.' || ch === ' ') continue;
      const col = pal[ch];
      if (col) px(g, x, y, col);
    }
  }
  return c;
}

export function mirror(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = makeCanvas(src.width, src.height);
  const g = g2d(c);
  g.translate(src.width, 0);
  g.scale(-1, 1);
  g.drawImage(src, 0, 0);
  return c;
}

// ── 색 ──
function parse(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toHex = (r: number, g: number, b: number) => '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');

export function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = parse(a);
  const [r2, g2, b2] = parse(b);
  return toHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}
export const lighten = (c: string, t: number) => mix(c, '#ffffff', t);
export const darken = (c: string, t: number) => mix(c, '#100c1c', t);
export function rgba(hex: string, a: number) {
  const [r, g, b] = parse(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/** 작은 의사 난수 생성기. 나뭇결이 늘 똑같이 나오게 한다. */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// ── 사무실 팔레트(저녁의 VibesMoney: 검정, 따뜻한 나무, 주황 하나) ──
export const P = {
  ink: '#15121d',
  inkSoft: '#231e2e',
  // 벽
  wallTop: '#14111c',
  wallFace: '#262236',
  wallFace2: '#2c2740',
  wallLine: '#1f1b2d',
  wallHi: '#37314d',
  baseboard: '#191523',
  // 바닥: 어둡고 따뜻한 마루
  floor1: '#3f3138',
  floor2: '#46363d',
  floor3: '#3a2d34',
  floorSeam: '#30252c',
  floorHi: '#504048',
  // 책상의 밝은 나무
  wood: '#c08a57',
  woodHi: '#d9a46c',
  woodLight: '#e7bb84',
  woodFront: '#9b6a3e',
  woodDark: '#77502e',
  woodLeg: '#563821',
  // 어두운 나무(팀장 책상)
  ebony: '#2a2530',
  ebonyHi: '#3b3443',
  ebonyFront: '#1e1a24',
  // 금속과 장비
  metal: '#9a9fb5',
  metalHi: '#cfd2e0',
  metalDark: '#62667c',
  tech: '#262431',
  techMid: '#363443',
  techHi: '#4d4a5e',
  screenOff: '#1a1f2e',
  // VibesMoney 주황
  orange: '#ff8a3d',
  orangeHi: '#ffb27a',
  orangeLight: '#ffd2a8',
  orangeDark: '#d9622a',
  orangeDeep: '#9e4019',
  // 초록 식물
  leafDeep: '#1f4733',
  leafDark: '#285e40',
  leaf: '#348050',
  leafHi: '#52a868',
  leafLight: '#86cf7c',
  pot: '#b8643f',
  potHi: '#d9875a',
  potDark: '#8a462a',
  potWhite: '#e9e5ef',
  potWhiteShade: '#bdb7c9',
  // 종이
  paper: '#f6f2e9',
  paperShade: '#d8d1c3',
  paperLine: '#a19a8c',
  // 의자 천
  fabric: '#2e2a3d',
  fabricHi: '#403a54',
  fabricDark: '#211d2c',
  white: '#f7f5fc',
  shadow: 'rgba(8,6,16,0.38)',
};
