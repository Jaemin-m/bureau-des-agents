// 사무실 간판용 글자. 라틴 문자와 숫자는 아주 작은 3 × 5 픽셀 글꼴로 직접 찍는다.
// 한글은 3 × 5에 들어가지 않으니 픽셀 글꼴 Galmuri7(8px)로 그린 뒤, 알파값을 문턱값으로 잘라 흐림 없는 픽셀로 만든다.
// 글꼴은 main.tsx가 화면을 그리기 전에 미리 불러 둔다.
import { makeCanvas, type G } from './pixels.ts';

/** 간판 글자가 차지하는 높이(픽셀). 3 × 5 글꼴도 이 높이 안에서 세로 가운데에 놓인다. */
export const TEXT_H = 8;
/** 한글 간판을 그리는 글꼴. */
export const HANGUL_FONT = '8px Galmuri7';

const GLYPHS: Record<string, string[]> = {
  A: ['.#.', '#.#', '###', '#.#', '#.#'],
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  C: ['.##', '#..', '#..', '#..', '.##'],
  D: ['##.', '#.#', '#.#', '#.#', '##.'],
  E: ['###', '#..', '##.', '#..', '###'],
  É: ['.##', '###', '#..', '##.', '###'],
  F: ['###', '#..', '##.', '#..', '#..'],
  G: ['.##', '#..', '#.#', '#.#', '.##'],
  H: ['#.#', '#.#', '###', '#.#', '#.#'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  J: ['..#', '..#', '..#', '#.#', '.#.'],
  K: ['#.#', '#.#', '##.', '#.#', '#.#'],
  L: ['#..', '#..', '#..', '#..', '###'],
  M: ['#.#', '###', '###', '#.#', '#.#'],
  N: ['##.', '#.#', '#.#', '#.#', '#.#'],
  O: ['.#.', '#.#', '#.#', '#.#', '.#.'],
  P: ['##.', '#.#', '##.', '#..', '#..'],
  Q: ['.#.', '#.#', '#.#', '##.', '.##'],
  R: ['##.', '#.#', '##.', '#.#', '#.#'],
  S: ['.##', '#..', '.#.', '..#', '##.'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  U: ['#.#', '#.#', '#.#', '#.#', '###'],
  V: ['#.#', '#.#', '#.#', '#.#', '.#.'],
  W: ['#.#', '#.#', '###', '###', '#.#'],
  X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
  Y: ['#.#', '#.#', '.#.', '.#.', '.#.'],
  Z: ['###', '..#', '.#.', '#..', '###'],
  '0': ['###', '#.#', '#.#', '#.#', '###'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['##.', '..#', '.#.', '#..', '###'],
  '3': ['##.', '..#', '.#.', '..#', '##.'],
  '4': ['#.#', '#.#', '###', '..#', '..#'],
  '5': ['###', '#..', '##.', '..#', '##.'],
  '6': ['.##', '#..', '###', '#.#', '###'],
  '7': ['###', '..#', '.#.', '.#.', '.#.'],
  '8': ['###', '#.#', '###', '#.#', '###'],
  '9': ['###', '#.#', '###', '..#', '##.'],
  ' ': ['..', '..', '..', '..', '..'],
  '·': ['.', '.', '#', '.', '.'],
  "'": ['#', '#', '.', '.', '.'],
  '!': ['#', '#', '#', '.', '#'],
};

/** 3 × 5 글꼴로 그릴 수 없는 글자(한글 등)가 들어 있으면 참. */
function needsFont(text: string) {
  for (const ch of text.toUpperCase()) if (!GLYPHS[ch]) return true;
  return false;
}

let measurer: G | null = null;
function measure(): G {
  if (!measurer) measurer = makeCanvas(1, 1).getContext('2d')!;
  measurer.font = HANGUL_FONT;
  return measurer;
}

/** 글꼴로 그린 글자를 문턱값으로 잘라 한 가지 색의 픽셀만 남긴 작은 그림. 글자와 색마다 한 번만 만든다. */
const rasters = new Map<string, HTMLCanvasElement>();
function raster(text: string, color: string): HTMLCanvasElement {
  const key = color + '\u0000' + text;
  const hit = rasters.get(key);
  if (hit) return hit;
  const w = Math.max(1, Math.ceil(measure().measureText(text).width));
  const c = makeCanvas(w, TEXT_H);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.font = HANGUL_FONT;
  g.textBaseline = 'top';
  g.fillStyle = color;
  g.fillText(text, 0, 0);
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) d[i] = d[i] >= 128 ? 255 : 0;
  g.putImageData(img, 0, 0);
  // 글꼴을 아직 못 불러왔으면 대체 글꼴로 그려졌을 수 있으니 기억하지 않는다
  if (document.fonts.check(HANGUL_FONT, text)) rasters.set(key, c);
  return c;
}

/** 글자의 너비(픽셀). */
export function textWidth(text: string) {
  if (needsFont(text)) return Math.ceil(measure().measureText(text).width);
  let w = 0;
  for (const ch of text.toUpperCase()) w += (GLYPHS[ch]?.[0].length ?? 3) + 1;
  return Math.max(0, w - 1);
}

/** 글자를 픽셀로 찍는다. (x, y)는 TEXT_H 높이 상자의 왼쪽 위. 너비를 돌려준다. */
export function pixelText(g: G, text: string, x: number, y: number, color: string) {
  if (needsFont(text)) {
    const r = raster(text, color);
    g.drawImage(r, Math.round(x), Math.round(y));
    return r.width;
  }
  g.fillStyle = color;
  let cx = Math.round(x);
  const top = Math.round(y) + Math.floor((TEXT_H - 5) / 2);
  for (const ch of text.toUpperCase()) {
    const glyph = GLYPHS[ch] ?? GLYPHS[' '];
    for (let r = 0; r < glyph.length; r++) {
      const row = glyph[r];
      for (let c = 0; c < row.length; c++) if (row[c] === '#') g.fillRect(cx + c, top + r, 1, 1);
    }
    cx += glyph[0].length + 1;
  }
  return cx - Math.round(x) - 1;
}
