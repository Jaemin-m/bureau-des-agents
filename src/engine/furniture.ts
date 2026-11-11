// 사무실 가구를 픽셀 하나하나 그린다. 가구마다 작은 이미지가 되어(메모리에 보관) 자기 칸에 놓인다.
// 움직이는 부분(화면, 표시등, 프린터에서 나오는 종이)은 엔진이 매 프레임 그 위에 그린다.
import type { Role } from '../../shared/protocol.ts';
import { ROLES } from '../../shared/activity.ts';
import type { Furn } from './layout.ts';
import { T } from './layout.ts';
import { g2d, hline, makeCanvas, mix, outline, P, px, rect, rng, vline, type G } from './pixels.ts';

export interface Sprite {
  c: HTMLCanvasElement;
  /** 칸의 왼쪽 위를 기준으로 한 이미지 왼쪽 위 위치 */
  ox: number;
  oy: number;
  /** 칸 위쪽을 기준으로 한 정렬선(깊이) */
  sort: number;
}

/** 픽셀 단위로 채운 작은 타원. */
function ellipse(g: G, cx: number, cy: number, rx: number, ry: number, color: string) {
  g.fillStyle = color;
  for (let y = -ry; y <= ry; y++) {
    const w = Math.round(rx * Math.sqrt(Math.max(0, 1 - (y * y) / (ry * ry + 0.01))));
    g.fillRect(Math.round(cx - w), Math.round(cy + y), w * 2 + 1, 1);
  }
}

// ── 책상 위 물건 ──

/** 뒤에서 본 노트북(화면은 뒤에 앉은 로봇을 향한다). */
function laptop(g: G, x: number, y: number, w = 12) {
  rect(g, x, y, w, 7, '#3a3646');
  hline(g, x, y, w, '#56516a');
  vline(g, x + w - 1, y + 1, 6, '#2b2836');
  // 로고(작은 큐브)는 에이전트가 일할 때 켜진다: 여기서는 꺼진 상태
  rect(g, x + w / 2 - 1, y + 2, 2, 2, '#5b4a44');
  rect(g, x - 1, y + 7, w + 2, 1, '#8f8aa1');
}

function globe(g: G, x: number, y: number) {
  rect(g, x + 1, y, 4, 1, '#2f6fae');
  rect(g, x, y + 1, 6, 4, '#3d8ad1');
  rect(g, x + 1, y + 5, 4, 1, '#2f6fae');
  rect(g, x + 1, y + 1, 2, 2, '#4fae62');
  rect(g, x + 3, y + 3, 2, 2, '#4fae62');
  px(g, x + 1, y + 1, '#9fe0ff');
  vline(g, x + 6, y + 1, 4, P.metalDark);
  vline(g, x + 3, y + 6, 2, P.metalDark);
  rect(g, x + 1, y + 8, 5, 1, P.metal);
}

function papers(g: G, x: number, y: number, n = 3) {
  for (let i = 0; i < n; i++) {
    rect(g, x + (i % 2), y + 3 - i, 7, 4, i === n - 1 ? P.paper : P.paperShade);
  }
  hline(g, x + 2, y + 5 - n + 2, 4, P.paperLine);
}

function mug(g: G, x: number, y: number, color = P.orange) {
  rect(g, x, y, 4, 4, '#f1eef6');
  hline(g, x, y + 1, 4, color);
  rect(g, x + 4, y + 1, 1, 2, '#d9d5e3');
  hline(g, x, y, 4, '#ffffff');
}

/** 뒤에서 본 받침대 위 모니터. */
function monitorBack(g: G, x: number, y: number) {
  rect(g, x, y, 9, 8, '#2b2836');
  hline(g, x, y, 9, '#45405a');
  vline(g, x + 8, y + 1, 7, '#211e2b');
  rect(g, x + 3, y + 8, 3, 3, '#3a3646');
  rect(g, x + 1, y + 11, 7, 1, '#4b465c');
}

function keyboard(g: G, x: number, y: number) {
  rect(g, x, y, 12, 3, '#cfcbd9');
  for (let i = 0; i < 5; i++) px(g, x + 1 + i * 2, y + 1, '#a29db3');
  hline(g, x, y + 2, 12, '#a9a4b8');
}

function cactus(g: G, x: number, y: number) {
  rect(g, x + 2, y, 2, 6, P.leaf);
  vline(g, x + 2, y, 6, P.leafHi);
  rect(g, x, y + 2, 2, 1, P.leaf);
  px(g, x, y + 1, P.leaf);
  rect(g, x + 4, y + 3, 2, 1, P.leaf);
  px(g, x + 5, y + 2, P.leaf);
  rect(g, x, y + 6, 6, 4, P.pot);
  hline(g, x, y + 6, 6, P.potHi);
}

function swatches(g: G, x: number, y: number) {
  rect(g, x, y, 7, 5, '#f1eef6');
  rect(g, x + 1, y + 1, 2, 2, '#ff6fa8');
  rect(g, x + 4, y + 1, 2, 2, '#ffd166');
  rect(g, x + 1, y + 3, 2, 1, '#4fb3ff');
  rect(g, x + 4, y + 3, 2, 1, P.orange);
}

function calculator(g: G, x: number, y: number) {
  rect(g, x, y, 5, 6, '#3a3646');
  rect(g, x + 1, y + 1, 3, 1, '#8fd9a8');
  for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) px(g, x + 1 + i * 2, y + 3 + j, '#cfcbd9');
}

/** 분석가의 작은 대시보드 화면(나를 향한다). */
function dashboard(g: G, x: number, y: number) {
  rect(g, x, y, 9, 8, '#2b2836');
  rect(g, x + 1, y + 1, 7, 6, '#141a2c');
  rect(g, x + 3, y + 8, 3, 3, '#3a3646');
  rect(g, x + 1, y + 11, 7, 1, '#4b465c');
}

/** 바닥에 눕혀 둔 드로잉 태블릿. */
function tablet(g: G, x: number, y: number) {
  rect(g, x, y, 13, 5, '#2b2836');
  rect(g, x + 1, y + 1, 11, 3, P.screenOff);
  hline(g, x, y, 13, '#45405a');
}

// ── 가구 ──

function deskSprite(role: Role, seed: number): Sprite {
  const c = makeCanvas(32, 28);
  const g = g2d(c);
  const r = rng(seed + 7);
  // 상판
  rect(g, 1, 8, 30, 10, P.wood);
  hline(g, 1, 8, 30, P.woodHi);
  hline(g, 1, 17, 30, P.woodLight);
  for (let i = 0; i < 9; i++) hline(g, 2 + Math.floor(r() * 22), 10 + Math.floor(r() * 6), 3 + Math.floor(r() * 5), mix(P.wood, P.woodDark, 0.22));
  // 앞판과 다리
  rect(g, 1, 18, 30, 6, P.woodFront);
  hline(g, 1, 23, 30, P.woodDark);
  rect(g, 19, 20, 8, 1, P.woodDark);
  px(g, 22, 21, P.woodHi);
  rect(g, 2, 24, 2, 3, P.woodLeg);
  rect(g, 28, 24, 2, 3, P.woodLeg);
  // 책상 위 물건은 직무마다 다르다
  switch (role) {
    case 'recherche':
      laptop(g, 10, 8);
      globe(g, 2, 4);
      papers(g, 23, 11);
      break;
    case 'code':
      monitorBack(g, 1, 1);
      monitorBack(g, 22, 1);
      keyboard(g, 10, 13);
      break;
    case 'design':
      tablet(g, 9, 11);
      cactus(g, 2, 5);
      swatches(g, 23, 10);
      break;
    case 'redaction':
      laptop(g, 10, 8);
      papers(g, 2, 10, 4);
      mug(g, 24, 11, ROLES.redaction.color);
      break;
    case 'analyse':
      laptop(g, 9, 8);
      dashboard(g, 22, 1);
      calculator(g, 2, 9);
      break;
    default:
      laptop(g, 10, 8);
  }
  outline(c, P.ink);
  // 바닥 그림자
  g.fillStyle = P.shadow;
  g.fillRect(2, 27, 28, 1);
  return { c, ox: 0, oy: -12, sort: 14 };
}

function chefDeskSprite(): Sprite {
  const c = makeCanvas(64, 30);
  const g = g2d(c);
  rect(g, 1, 8, 62, 10, P.ebony);
  hline(g, 1, 8, 62, P.ebonyHi);
  hline(g, 1, 17, 62, '#4a4254');
  rect(g, 1, 18, 62, 9, P.ebonyFront);
  // 주황 테두리(밤에 켜진다)
  hline(g, 2, 25, 60, P.orangeDark);
  // “팀장” 명패
  rect(g, 27, 20, 10, 3, P.orange);
  hline(g, 28, 21, 2, P.orangeDeep);
  hline(g, 31, 21, 1, P.orangeDeep);
  hline(g, 33, 21, 3, P.orangeDeep);
  // 책상 스탠드
  rect(g, 5, 14, 6, 2, '#3a3646');
  for (let i = 0; i < 6; i++) px(g, 8 + Math.floor(i / 2), 13 - i, P.metal);
  rect(g, 9, 4, 7, 3, '#2b2836');
  hline(g, 10, 7, 5, '#ffd27a');
  // 컴퓨터와 결과물 서류함
  laptop(g, 26, 8, 12);
  rect(g, 45, 11, 14, 5, P.metalDark);
  rect(g, 46, 11, 12, 4, '#1f1c27');
  hline(g, 45, 11, 14, P.metal);
  mug(g, 40, 11);
  outline(c, '#07060a');
  g.fillStyle = P.shadow;
  g.fillRect(2, 29, 60, 1);
  return { c, ox: 0, oy: -12, sort: 14 };
}

function chairSprite(): Sprite {
  const c = makeCanvas(16, 18);
  const g = g2d(c);
  rect(g, 3, 1, 10, 8, P.fabric);
  hline(g, 3, 1, 10, P.fabricHi);
  vline(g, 12, 2, 7, P.fabricDark);
  rect(g, 2, 9, 12, 3, P.fabricHi);
  hline(g, 2, 11, 12, P.fabric);
  rect(g, 1, 7, 2, 4, '#1d1b26');
  rect(g, 13, 7, 2, 4, '#1d1b26');
  rect(g, 7, 12, 2, 3, '#1d1b26');
  rect(g, 4, 15, 8, 1, '#1d1b26');
  outline(c, P.ink);
  return { c, ox: 8, oy: -1, sort: 14 };
}

function chefChairSprite(): Sprite {
  const c = makeCanvas(20, 26);
  const g = g2d(c);
  rect(g, 3, 0, 14, 15, P.orangeDark);
  rect(g, 5, 2, 10, 11, P.orange);
  hline(g, 3, 0, 14, P.orangeHi);
  for (const y of [5, 9]) hline(g, 5, y, 10, P.orangeDark);
  vline(g, 16, 1, 14, P.orangeDeep);
  rect(g, 2, 15, 16, 4, P.orangeDark);
  hline(g, 2, 15, 16, P.orange);
  rect(g, 0, 10, 3, 6, '#2b2836');
  rect(g, 17, 10, 3, 6, '#2b2836');
  rect(g, 9, 19, 2, 4, '#1d1b26');
  rect(g, 5, 23, 10, 1, '#1d1b26');
  outline(c, '#07060a');
  return { c, ox: 6, oy: -9, sort: 14 };
}

/** 잎 하나하나 그린 무성한 화분(같은 시드면 늘 같은 모양). */
function plantBigSprite(seed: number): Sprite {
  const c = makeCanvas(20, 30);
  const g = g2d(c);
  const r = rng(seed);
  // 잎
  ellipse(g, 10, 11, 8, 8, P.leafDark);
  for (let i = 0; i < 14; i++) {
    const a = r() * Math.PI * 2;
    const d = r() * 6;
    ellipse(g, 10 + Math.cos(a) * d, 10 + Math.sin(a) * d * 0.9, 2 + Math.floor(r() * 2), 2, r() < 0.5 ? P.leaf : P.leafDark);
  }
  for (let i = 0; i < 9; i++) {
    const a = Math.PI * (1.05 + r() * 0.9);
    const d = 2 + r() * 5;
    ellipse(g, 9 + Math.cos(a) * d, 9 + Math.sin(a) * d, 1 + Math.floor(r() * 2), 1, P.leafHi);
  }
  for (let i = 0; i < 5; i++) px(g, 5 + Math.floor(r() * 9), 4 + Math.floor(r() * 8), P.leafLight);
  for (let i = 0; i < 6; i++) px(g, 6 + Math.floor(r() * 9), 13 + Math.floor(r() * 5), P.leafDeep);
  // 줄기와 화분
  rect(g, 9, 18, 2, 3, P.leafDeep);
  rect(g, 5, 21, 10, 2, P.potHi);
  rect(g, 6, 23, 8, 5, P.pot);
  vline(g, 13, 23, 5, P.potDark);
  hline(g, 6, 27, 8, P.potDark);
  outline(c, P.ink);
  return { c, ox: -2, oy: -14, sort: 14 };
}

/** 흰 화분에 심은 산세베리아(곧고 뾰족한 잎). */
function plantTallSprite(seed: number): Sprite {
  const c = makeCanvas(14, 30);
  const g = g2d(c);
  const r = rng(seed);
  const leaves = [[3, 9], [5, 3], [7, 6], [9, 2], [10, 10], [6, 12]];
  for (const [x, top] of leaves) {
    const t = top + Math.floor(r() * 3);
    rect(g, x, t, 2, 22 - t, P.leaf);
    vline(g, x, t + 1, 21 - t, P.leafHi);
    px(g, x, t, P.leafLight);
    for (let y = t + 3; y < 21; y += 4) px(g, x + 1, y, P.leafDark);
    vline(g, x + 1, t, 22 - t, mix(P.leaf, '#d6e07a', 0.25));
  }
  rect(g, 3, 21, 9, 2, P.potWhite);
  rect(g, 4, 23, 7, 5, P.potWhite);
  vline(g, 10, 23, 5, P.potWhiteShade);
  hline(g, 4, 27, 7, P.potWhiteShade);
  outline(c, P.ink);
  return { c, ox: 1, oy: -14, sort: 14 };
}

function rackSprite(): Sprite {
  const c = makeCanvas(16, 32);
  const g = g2d(c);
  rect(g, 1, 0, 14, 4, '#34313f');
  hline(g, 1, 0, 14, '#4a465a');
  rect(g, 1, 4, 14, 26, '#1c1a25');
  vline(g, 14, 4, 26, '#141219');
  vline(g, 1, 4, 26, '#2b2836');
  for (let i = 0; i < 6; i++) {
    const y = 6 + i * 4;
    hline(g, 2, y + 3, 12, '#2a2735');
    rect(g, 7, y + 1, 6, 1, '#2f2c3b');
  }
  rect(g, 2, 30, 12, 1, '#2b2836');
  outline(c, P.ink);
  return { c, ox: 0, oy: -16, sort: 15 };
}

function printerSprite(): Sprite {
  const c = makeCanvas(16, 30);
  const g = g2d(c);
  rect(g, 1, 14, 14, 14, '#bdb9c9');
  hline(g, 1, 14, 14, '#dad7e3');
  hline(g, 2, 20, 12, '#a29db2');
  hline(g, 2, 25, 12, '#a29db2');
  rect(g, 7, 17, 2, 1, '#8a859b');
  rect(g, 7, 22, 2, 1, '#8a859b');
  rect(g, 0, 5, 16, 9, '#ecebf2');
  rect(g, 0, 5, 16, 2, '#f8f7fc');
  rect(g, 3, 7, 10, 1, '#3a3646');
  rect(g, 2, 11, 12, 3, '#d4d1de');
  hline(g, 2, 13, 12, '#b5b1c3');
  vline(g, 15, 6, 8, '#c9c6d4');
  outline(c, P.ink);
  return { c, ox: 0, oy: -14, sort: 14 };
}

function coolerSprite(): Sprite {
  const c = makeCanvas(12, 30);
  const g = g2d(c);
  rect(g, 3, 1, 6, 1, '#cfe9ff');
  rect(g, 2, 2, 8, 10, '#7fc6ff');
  vline(g, 3, 3, 8, '#bfe3ff');
  vline(g, 9, 3, 9, '#4f9be0');
  rect(g, 4, 12, 4, 2, '#3a3646');
  rect(g, 1, 14, 10, 14, '#e6e4ee');
  vline(g, 10, 14, 14, '#c3bfd1');
  rect(g, 4, 17, 2, 2, '#4fb3ff');
  rect(g, 7, 17, 2, 2, '#ff6b5e');
  hline(g, 2, 24, 8, '#c3bfd1');
  outline(c, P.ink);
  return { c, ox: 2, oy: -14, sort: 14 };
}

function coffeeSprite(): Sprite {
  const c = makeCanvas(48, 26);
  const g = g2d(c);
  rect(g, 0, 9, 48, 4, P.wood);
  hline(g, 0, 9, 48, P.woodHi);
  rect(g, 0, 13, 48, 12, '#e3e0ea');
  for (const x of [15, 31]) vline(g, x, 14, 10, '#bdb9cb');
  for (const x of [11, 19, 27, 35]) rect(g, x, 18, 2, 1, '#9f9ab0');
  hline(g, 0, 24, 48, '#bdb9cb');
  // 커피 머신
  rect(g, 5, 0, 12, 9, '#2b2836');
  hline(g, 5, 0, 12, '#45405a');
  rect(g, 7, 2, 8, 2, '#1a1822');
  rect(g, 9, 5, 4, 4, '#1a1822');
  rect(g, 10, 7, 2, 2, '#f1eef6');
  // 컵
  mug(g, 22, 5);
  mug(g, 29, 5, '#4fb3ff');
  // 작은 화분
  rect(g, 39, 5, 6, 4, P.pot);
  ellipse(g, 42, 3, 3, 2, P.leaf);
  px(g, 41, 2, P.leafHi);
  outline(c, P.ink);
  return { c, ox: 0, oy: -10, sort: 14 };
}

function sofaSprite(): Sprite {
  const c = makeCanvas(48, 22);
  const g = g2d(c);
  rect(g, 3, 0, 42, 10, P.orangeDark);
  rect(g, 4, 1, 40, 7, P.orange);
  hline(g, 3, 0, 42, P.orangeHi);
  for (const x of [17, 31]) vline(g, x, 1, 8, P.orangeDark);
  rect(g, 3, 10, 42, 6, P.orange);
  hline(g, 3, 10, 42, P.orangeHi);
  for (const x of [17, 31]) vline(g, x, 10, 6, P.orangeDark);
  hline(g, 3, 15, 42, P.orangeDark);
  rect(g, 0, 4, 4, 13, P.orangeDark);
  rect(g, 44, 4, 4, 13, P.orangeDark);
  hline(g, 0, 4, 4, P.orange);
  hline(g, 44, 4, 4, P.orange);
  rect(g, 2, 17, 2, 3, '#2b2836');
  rect(g, 44, 17, 2, 3, '#2b2836');
  outline(c, P.ink);
  return { c, ox: 0, oy: -6, sort: 14 };
}

function tableLowSprite(): Sprite {
  const c = makeCanvas(26, 12);
  const g = g2d(c);
  rect(g, 1, 3, 24, 4, P.wood);
  hline(g, 1, 3, 24, P.woodHi);
  rect(g, 1, 7, 24, 2, P.woodFront);
  rect(g, 2, 9, 2, 2, P.woodLeg);
  rect(g, 22, 9, 2, 2, P.woodLeg);
  mug(g, 6, 0);
  rect(g, 14, 2, 6, 3, P.paper);
  hline(g, 15, 3, 4, P.paperLine);
  outline(c, P.ink);
  return { c, ox: 4, oy: 4, sort: 15 };
}

function lampSprite(): Sprite {
  const c = makeCanvas(12, 32);
  const g = g2d(c);
  rect(g, 3, 1, 6, 1, '#f6e3bd');
  rect(g, 2, 2, 8, 6, '#f2d8a8');
  rect(g, 1, 7, 10, 1, '#c9a46a');
  vline(g, 9, 2, 5, '#d8bb85');
  rect(g, 5, 8, 2, 20, P.metalDark);
  vline(g, 5, 8, 20, P.metal);
  rect(g, 3, 28, 6, 2, '#2b2836');
  outline(c, P.ink);
  return { c, ox: 2, oy: -16, sort: 14 };
}

function shelfSprite(seed: number): Sprite {
  const c = makeCanvas(32, 30);
  const g = g2d(c);
  const r = rng(seed + 3);
  rect(g, 0, 0, 32, 30, '#5e4130');
  rect(g, 2, 2, 28, 26, '#2a2230');
  const colors = ['#ff8a3d', '#4fb3ff', '#3ddc97', '#a98bff', '#ffd166', '#ff6fa8', '#e9e5ef', '#c08a57'];
  for (const sy of [2, 11, 20]) {
    let x = 3;
    while (x < 28) {
      const w = 2 + Math.floor(r() * 2);
      const h = 5 + Math.floor(r() * 3);
      if (r() < 0.15) { x += 2; continue; }
      rect(g, x, sy + 8 - h, w, h, colors[Math.floor(r() * colors.length)]);
      px(g, x, sy + 8 - h, '#ffffff33');
      x += w;
    }
    rect(g, 1, sy + 8, 30, 1, '#7a5638');
  }
  hline(g, 0, 0, 32, '#7a5638');
  outline(c, P.ink);
  return { c, ox: 0, oy: -14, sort: 14 };
}

function easelSprite(): Sprite {
  const c = makeCanvas(16, 30);
  const g = g2d(c);
  for (let i = 0; i < 26; i++) { px(g, 3 + Math.floor(i / 8), 3 + i, P.woodDark); px(g, 12 - Math.floor(i / 8), 3 + i, P.woodDark); }
  vline(g, 8, 2, 26, P.woodFront);
  rect(g, 1, 2, 14, 13, '#f6f2e9');
  rect(g, 2, 3, 12, 6, '#7fc6ff');
  ellipse(g, 10, 6, 2, 2, P.orange);
  rect(g, 2, 9, 12, 5, '#ff6fa8');
  rect(g, 2, 11, 7, 3, '#a98bff');
  rect(g, 1, 15, 14, 1, P.wood);
  outline(c, P.ink);
  return { c, ox: 0, oy: -14, sort: 14 };
}

function binSprite(): Sprite {
  const c = makeCanvas(9, 10);
  const g = g2d(c);
  rect(g, 1, 2, 7, 7, '#5d6178');
  for (let x = 2; x < 8; x += 2) vline(g, x, 3, 5, '#7b8099');
  hline(g, 1, 2, 7, '#9aa0b8');
  rect(g, 3, 0, 3, 2, P.paper);
  outline(c, P.ink);
  return { c, ox: 4, oy: 5, sort: 15 };
}

/** 주크박스: 네온 아치(음악이 나오면 엔진이 켠다), 레코드판, 그릴. */
function jukeboxSprite(): Sprite {
  const c = makeCanvas(32, 38);
  const g = g2d(c);
  // 나무 아치
  for (let y = 0; y < 16; y++) {
    const half = Math.round(Math.sqrt(Math.max(0, 15 * 15 - (15 - y) * (15 - y))));
    rect(g, 16 - half, y, half * 2, 1, '#8a5530');
  }
  rect(g, 1, 15, 30, 19, '#8a5530');
  vline(g, 30, 8, 26, '#6a3f22');
  // 아치 안쪽(네온은 그 위에 그린다)
  for (let y = 3; y < 16; y++) {
    const half = Math.round(Math.sqrt(Math.max(0, 12 * 12 - (15 - y) * (15 - y))));
    rect(g, 16 - half, y, half * 2, 1, '#2a1f2a');
  }
  // 레코드 창
  rect(g, 6, 16, 20, 9, '#c9cbd6');
  rect(g, 7, 17, 18, 7, '#141019');
  rect(g, 11, 18, 10, 5, '#0b0910');
  rect(g, 15, 20, 2, 1, P.orange);
  // 스피커 그릴
  rect(g, 5, 26, 22, 7, '#5a3520');
  for (let x = 6; x < 27; x += 2) vline(g, x, 27, 5, '#3d2416');
  rect(g, 0, 34, 32, 3, '#3a3646');
  hline(g, 0, 34, 32, '#5b566a');
  outline(c, P.ink);
  return { c, ox: 0, oy: -22, sort: 14 };
}

const cache = new Map<string, Sprite>();

export function furnitureSprite(f: Furn): Sprite {
  const key = `${f.kind}|${f.role ?? ''}|${f.seed ?? 0}`;
  let s = cache.get(key);
  if (s) return s;
  switch (f.kind) {
    case 'desk': s = deskSprite(f.role ?? 'renfort', f.seed ?? 1); break;
    case 'chefDesk': s = chefDeskSprite(); break;
    case 'chair': s = chairSprite(); break;
    case 'chefChair': s = chefChairSprite(); break;
    case 'plantBig': s = plantBigSprite(f.seed ?? 1); break;
    case 'plantTall': s = plantTallSprite(f.seed ?? 1); break;
    case 'plantSmall': s = plantBigSprite(f.seed ?? 1); break;
    case 'rack': s = rackSprite(); break;
    case 'printer': s = printerSprite(); break;
    case 'cooler': s = coolerSprite(); break;
    case 'coffee': s = coffeeSprite(); break;
    case 'sofa': s = sofaSprite(); break;
    case 'tableLow': s = tableLowSprite(); break;
    case 'lamp': s = lampSprite(); break;
    case 'shelf': s = shelfSprite(f.seed ?? 1); break;
    case 'easel': s = easelSprite(); break;
    case 'bin': s = binSprite(); break;
    case 'jukebox': s = jukeboxSprite(); break;
  }
  cache.set(key, s);
  return s;
}

/** 가구의 왼쪽 위(픽셀)와 정렬선. */
export function furniturePlacement(f: Furn) {
  const s = furnitureSprite(f);
  return { s, x: f.tx * T + s.ox, y: f.ty * T + s.oy, sortY: f.ty * T + s.sort };
}

