// 사무실 로봇: VibesMoney 로고 같은 큐브 로봇(검은 바이저, 주황 눈).
// 팀장 맥스는 로고 속 검은 로봇이고, 팀원은 흰색에 직무 색과 소품을 단다
// (디자이너의 베레모, 분석가의 안경…). 모두 코드로 자세마다 그린 뒤 메모리에 보관한다.
import type { Role } from '../../shared/protocol.ts';
import { ROLES } from '../../shared/activity.ts';
import { darken, g2d, lighten, makeCanvas, mirror, outline, P, px, rect } from './pixels.ts';

export type Dir = 'down' | 'up' | 'left' | 'right';
export type Pose = 'stand' | 'walk' | 'sit' | 'type' | 'read' | 'think' | 'carry' | 'raise' | 'cheer' | 'wave' | 'write';
export type Eyes = 'open' | 'blink' | 'down' | 'up' | 'left' | 'right' | 'happy';

/** 로봇 스프라이트 크기. 발(윤곽의 아래 끝)이 기준점에 온다. */
export const ROBOT_W = 20;
export const ROBOT_H = 24;
export const ANCHOR_X = 10;
export const ANCHOR_Y = 22;

interface Look {
  chef: boolean;
  role: Role;
  top: string; front: string; shade: string; visor: string; visorHi: string;
  body: string; bodyHi: string; bodyShade: string;
  arm: string; hand: string; leg: string; tip: string;
}

function lookOf(role: Role): Look {
  if (role === 'chef') {
    return {
      chef: true, role,
      top: '#77718a', front: '#4a4658', shade: '#33303f', visor: '#0b0910', visorHi: '#4a4566',
      body: '#4a4658', bodyHi: '#615c73', bodyShade: '#33303f', arm: '#5a5569', hand: '#3d3a4a', leg: '#2a2734', tip: P.orange,
    };
  }
  const c = ROLES[role].color;
  return {
    chef: false, role,
    top: '#ffffff', front: '#e8e5f1', shade: '#c4bfd4', visor: '#15121c', visorHi: '#3d3852',
    body: c, bodyHi: lighten(c, 0.3), bodyShade: darken(c, 0.25), arm: '#d7d3e2', hand: '#b9b4c9', leg: '#3a3547', tip: c,
  };
}

const EYE = P.orange;
const EYE_HI = '#ffe2c4';
const EYE_DIM = '#c8612a';

/** 바이저 안의 눈(정면). ox, oy = 시선 이동량. */
function drawEyes(g: CanvasRenderingContext2D, eyes: Eyes, bob: number) {
  const y0 = 8 + bob;
  if (eyes === 'blink') {
    rect(g, 7, y0 + 1, 2, 1, EYE_DIM);
    rect(g, 11, y0 + 1, 2, 1, EYE_DIM);
    return;
  }
  if (eyes === 'happy') {
    for (const x of [7, 11]) {
      rect(g, x, y0, 2, 1, EYE);
      px(g, x - 1, y0 + 1, EYE);
      px(g, x + 2, y0 + 1, EYE);
    }
    return;
  }
  const ox = eyes === 'left' ? -1 : eyes === 'right' ? 1 : 0;
  const oy = eyes === 'down' ? 1 : eyes === 'up' ? -1 : 0;
  for (const x of [7, 11]) {
    rect(g, x + ox, y0 + oy, 2, 2, EYE);
    px(g, x + ox, y0 + oy, EYE_HI);
  }
}

/** 앞, 뒤, 옆에서 본 머리(큐브). */
function drawHead(g: CanvasRenderingContext2D, L: Look, dir: Dir, eyes: Eyes, bob: number) {
  const y = 4 + bob;
  // 큐브 윗면(더 밝게), 그다음 앞면
  rect(g, 4, y, 12, 2, L.top);
  rect(g, 4, y + 2, 12, 8, L.front);
  rect(g, 15, y + 2, 1, 8, L.shade);
  rect(g, 4, y + 9, 12, 1, L.shade);
  // 윗면과 앞면 사이의 밝은 모서리
  rect(g, 4, y + 2, 11, 1, lighten(L.front, 0.12));
  if (dir === 'down') {
    rect(g, 6, y + 3, 8, 4, L.visor);
    rect(g, 6, y + 3, 3, 1, L.visorHi);
    drawEyes(g, eyes, bob);
  } else if (dir === 'up') {
    // 뒤통수: 작은 환기 그릴
    rect(g, 8, y + 5, 4, 1, L.shade);
    rect(g, 8, y + 7, 4, 1, L.shade);
  } else {
    // 옆모습(오른쪽): 바이저가 머리 앞쪽을 차지하고 눈은 하나
    rect(g, 10, y + 3, 6, 4, L.visor);
    rect(g, 10, y + 3, 2, 1, L.visorHi);
    const oy = eyes === 'down' ? 1 : eyes === 'up' ? -1 : 0;
    if (eyes === 'blink') rect(g, 13, y + 5, 2, 1, EYE_DIM);
    else if (eyes === 'happy') { rect(g, 13, y + 4, 2, 1, EYE); px(g, 12, y + 5, EYE); }
    else { rect(g, 13, y + 4 + oy, 2, 2, EYE); px(g, 13, y + 4 + oy, EYE_HI); }
    rect(g, 4, y + 2, 1, 8, L.shade);
  }
}

/** 작은 색 구슬이 달린 안테나. */
function drawAntenna(g: CanvasRenderingContext2D, L: Look, bob: number) {
  rect(g, 9, 3 + bob, 2, 1, L.chef ? '#5b566a' : '#9d98ae');
  rect(g, 9, 1 + bob, 2, 2, L.tip);
  px(g, 9, 1 + bob, lighten(L.tip, 0.5));
}

/** 머리 위에 얹는 직무 소품. */
function drawAccessory(g: CanvasRenderingContext2D, L: Look, dir: Dir, bob: number) {
  const y = bob;
  switch (L.role) {
    case 'design': { // 비스듬히 쓴 분홍 베레모
      const c = ROLES.design.color;
      rect(g, 5, 2 + y, 10, 2, c);
      rect(g, 4, 3 + y, 12, 1, darken(c, 0.15));
      rect(g, 6, 1 + y, 6, 1, lighten(c, 0.25));
      px(g, 11, 0 + y, darken(c, 0.3));
      break;
    }
    case 'recherche': { // 탐험가 모자(정보 사냥을 떠난다)
      rect(g, 3, 4 + y, 14, 1, '#d6bd86');
      rect(g, 6, 1 + y, 8, 3, '#c7aa70');
      rect(g, 6, 3 + y, 8, 1, '#7c6337');
      rect(g, 7, 1 + y, 6, 1, '#e3cf9e');
      break;
    }
    case 'code': { // 헤드폰
      const c = ROLES.code.color;
      rect(g, 4, 3 + y, 12, 1, '#2b2836');
      if (dir === 'left' || dir === 'right') {
        rect(g, 7, 6 + y, 3, 4, c);
        rect(g, 7, 9 + y, 3, 1, darken(c, 0.3));
      } else {
        rect(g, 2, 6 + y, 2, 5, c);
        rect(g, 16, 6 + y, 2, 5, c);
        rect(g, 2, 10 + y, 2, 1, darken(c, 0.3));
        rect(g, 16, 10 + y, 2, 1, darken(c, 0.3));
      }
      break;
    }
    case 'analyse': { // 바이저 위의 안경
      if (dir === 'down') {
        const f = '#f3f1f8';
        for (const x of [6, 10]) {
          rect(g, x, 7 + y, 4, 1, f);
          rect(g, x, 10 + y, 4, 1, f);
          rect(g, x, 7 + y, 1, 4, f);
          rect(g, x + 3, 7 + y, 1, 4, f);
        }
      } else if (dir !== 'up') {
        rect(g, 12, 7 + y, 4, 1, '#f3f1f8');
        rect(g, 12, 10 + y, 4, 1, '#f3f1f8');
        rect(g, 12, 7 + y, 1, 4, '#f3f1f8');
      }
      break;
    }
    case 'redaction': { // 귀에 꽂은 연필
      if (dir === 'down') {
        px(g, 16, 3 + y, '#ff8fb1');
        rect(g, 16, 4 + y, 1, 5, '#ffd166');
        px(g, 16, 9 + y, '#3a3547');
      }
      break;
    }
  }
}

interface Limbs { la: [number, number, number]; ra: [number, number, number]; ll: number; rl: number }

/** 앞이나 뒤에서 본 몸통, 팔, 다리. */
function drawBodyFront(g: CanvasRenderingContext2D, L: Look, dir: Dir, limbs: Limbs, bob: number, seated: boolean) {
  const y = 14 + bob;
  // 다리(앉으면 책상 밑에 가려진다)
  if (!seated) {
    rect(g, 7, 19, 2, 3 - limbs.ll, L.leg);
    rect(g, 11, 19, 2, 3 - limbs.rl, L.leg);
  }
  // 몸통
  rect(g, 6, y, 8, 5, L.body);
  rect(g, 6, y, 8, 1, L.bodyHi);
  rect(g, 6, y + 4, 8, 1, L.bodyShade);
  rect(g, 13, y + 1, 1, 3, L.bodyShade);
  if (L.chef && dir === 'down') {
    // 팀장의 주황 넥타이
    rect(g, 9, y, 2, 1, P.orangeDark);
    rect(g, 9, y + 1, 2, 2, P.orange);
    px(g, 9, y + 3, P.orange);
  } else if (!L.chef && dir === 'down') {
    // 가슴의 작은 표시등
    px(g, 8, y + 2, lighten(L.body, 0.55));
  }
  // 팔: [x, y, 높이]
  for (const [x, ay, h] of [limbs.la, limbs.ra]) {
    rect(g, x, ay + bob, 2, h, L.arm);
    rect(g, x, ay + bob + h - 1, 2, 1, L.hand);
  }
}

function drawBodySide(g: CanvasRenderingContext2D, L: Look, frame: number, walking: boolean, bob: number, pose: Pose) {
  const y = 14 + bob;
  const swing = walking ? [0, 1, 0, -1][frame % 4] : 0;
  // 다리: 하나는 앞, 하나는 뒤
  rect(g, 8 + swing, 19, 2, 3, darken(L.leg, 0.15));
  rect(g, 10 - swing, 19, 2, 3, L.leg);
  rect(g, 7, y, 7, 5, L.body);
  rect(g, 7, y, 7, 1, L.bodyHi);
  rect(g, 7, y + 4, 7, 1, L.bodyShade);
  if (pose === 'carry') {
    // 앞에 들고 있는 종이
    rect(g, 12, y, 5, 6, P.paper);
    rect(g, 13, y + 2, 3, 1, P.paperLine);
    rect(g, 13, y + 4, 2, 1, P.paperLine);
    rect(g, 11, y + 1, 3, 2, L.arm);
  } else {
    rect(g, 9 - swing, y + 1, 2, 4, L.arm);
    rect(g, 9 - swing, y + 4, 2, 1, L.hand);
  }
}

function limbsFor(pose: Pose, frame: number): Limbs {
  const f = frame % 4;
  switch (pose) {
    case 'walk':
      return { la: [4, 14 + (f === 1 ? 1 : f === 3 ? -1 : 0), 4], ra: [14, 14 + (f === 1 ? -1 : f === 3 ? 1 : 0), 4], ll: f === 1 ? 1 : 0, rl: f === 3 ? 1 : 0 };
    case 'type':
      return { la: [5, 16 - (frame % 2 === 0 ? 1 : 0), 3], ra: [13, 16 - (frame % 2 === 1 ? 1 : 0), 3], ll: 0, rl: 0 };
    case 'sit':
    case 'read':
      return { la: [5, 16, 3], ra: [13, 16, 3], ll: 0, rl: 0 };
    case 'think':
      return { la: [4, 14, 4], ra: [13, 11, 4], ll: 0, rl: 0 };
    case 'raise':
      return { la: [4, 14, 4], ra: [15, 2 + (frame % 2), 6], ll: 0, rl: 0 };
    case 'cheer':
      return { la: [3, 3 + (frame % 2), 6], ra: [15, 3 + ((frame + 1) % 2), 6], ll: frame % 2, rl: (frame + 1) % 2 };
    case 'wave':
      return { la: [4, 14, 4], ra: [15 + (frame % 2), 4, 6], ll: 0, rl: 0 };
    case 'write':
      return { la: [4, 14, 4], ra: [14, 7 + (frame % 2), 6], ll: 0, rl: 0 };
    case 'carry':
      return { la: [5, 15, 3], ra: [13, 15, 3], ll: 0, rl: 0 };
    default:
      return { la: [4, 14, 4], ra: [14, 14, 4], ll: 0, rl: 0 };
  }
}

function build(role: Role, pose: Pose, dir: Dir, frame: number, eyes: Eyes): HTMLCanvasElement {
  const L = lookOf(role);
  if (dir === 'left') return mirror(build(role, pose, 'right', frame, eyes));
  const c = makeCanvas(ROBOT_W, ROBOT_H);
  const g = g2d(c);
  const seated = pose === 'sit' || pose === 'type' || pose === 'read' || (pose === 'think' && frame >= 100);
  const walking = pose === 'walk';
  const f = frame % 4;
  const bob = walking ? (f === 1 || f === 3 ? -1 : 0) : pose === 'cheer' ? -(frame % 2) : 0;
  const hatted = L.role === 'design' || L.role === 'recherche';
  if (dir === 'right') {
    drawBodySide(g, L, frame, walking, bob, pose);
    if (!hatted) drawAntenna(g, L, bob);
    drawHead(g, L, 'right', eyes, bob);
    drawAccessory(g, L, 'right', bob);
  } else {
    const limbs = limbsFor(pose, frame);
    // 든 팔은 머리 뒤로 가니 먼저 그린다
    drawBodyFront(g, L, dir, limbs, bob, seated);
    if (!hatted) drawAntenna(g, L, bob);
    drawHead(g, L, dir, eyes, bob);
    drawAccessory(g, L, dir, bob);
    if (pose === 'carry' && dir === 'down') {
      // 배 앞에 두 손으로 든 종이
      rect(g, 7, 15 + bob, 6, 6, P.paper);
      rect(g, 8, 17 + bob, 4, 1, P.paperLine);
      rect(g, 8, 19 + bob, 3, 1, P.paperLine);
      rect(g, 12, 15 + bob, 1, 6, P.paperShade);
      rect(g, 5, 16 + bob, 2, 2, L.hand);
      rect(g, 13, 16 + bob, 2, 2, L.hand);
    }
    if ((pose === 'raise' || pose === 'cheer' || pose === 'wave') && dir === 'down') {
      // 든 팔이 머리를 덮을 때는 머리 위에 다시 그린다
      const [x, ay, h] = limbs.ra;
      if (x <= 15) { rect(g, x, ay + bob, 2, h, L.arm); rect(g, x, ay + bob, 2, 1, L.hand); }
      if (pose === 'cheer') { const [lx, ly, lh] = limbs.la; rect(g, lx, ly + bob, 2, lh, L.arm); rect(g, lx, ly + bob, 2, 1, L.hand); }
    }
  }
  outline(c, L.chef ? '#07060a' : P.ink);
  return c;
}

const cache = new Map<string, HTMLCanvasElement>();

/** 로봇 스프라이트(메모리에 보관: 자세마다 한 번만 그린다). */
export function robotSprite(role: Role, pose: Pose, dir: Dir, frame: number, eyes: Eyes = 'open'): HTMLCanvasElement {
  const key = `${role}|${pose}|${dir}|${frame}|${eyes}`;
  let c = cache.get(key);
  if (!c) {
    c = build(role, pose, dir, frame, eyes);
    cache.set(key, c);
  }
  return c;
}

/** 크게 그린 로봇 얼굴(대화 상자용). */
export function portrait(role: Role, eyes: Eyes, scale: number): HTMLCanvasElement {
  const src = robotSprite(role, 'stand', 'down', 0, eyes);
  const c = makeCanvas(16 * scale, 16 * scale);
  const g = g2d(c);
  g.drawImage(src, 2, 0, 16, 16, 0, 0, 16 * scale, 16 * scale);
  return c;
}
