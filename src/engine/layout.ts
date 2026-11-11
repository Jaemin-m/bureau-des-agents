// 사무실 배치도: 16픽셀 칸 22 × 16개 격자, 위에서 내려다본 모습(픽셀 아트 게임처럼 3/4 시점).
// 직무마다 자기 구역과 책상, 의자가 있다. 맥스는 가운데, 계획 칠판 앞에 있고,
// 문은 아래쪽에 있어서 팀원은 그리로 들어온다.
import type { Role } from '../../shared/protocol.ts';

export const T = 16;
export const COLS = 22;
export const ROWS = 16;
export const W = COLS * T;
export const H = ROWS * T;

export type FurnKind =
  | 'desk' | 'chefDesk' | 'chair' | 'chefChair' | 'plantBig' | 'plantTall' | 'plantSmall' | 'rack' | 'printer'
  | 'cooler' | 'coffee' | 'sofa' | 'tableLow' | 'shelf' | 'lamp' | 'easel' | 'bin' | 'jukebox';

export interface Furn {
  id: string;
  kind: FurnKind;
  /** 바닥 점유 영역의 왼쪽 위 칸 */
  tx: number;
  ty: number;
  /** 바닥 점유 영역, 칸 단위(지나갈 수 없다) */
  w: number;
  h: number;
  role?: Role;
  seed?: number;
}

export interface Seat {
  id: string;
  role: Role;
  /** 로봇이 앉기 전에 멈추는 칸 */
  tile: [number, number];
  /** 앉았을 때 로봇 발의 위치(픽셀) */
  x: number;
  y: number;
  deskId: string;
}

export interface Zone { role: Role; label: string; x: number; y: number; w: number; h: number }

/** 사무실의 구역(바닥 러그와 이름표). */
export const ZONES: Zone[] = [
  { role: 'recherche', label: '리서치', x: 1, y: 3, w: 6, h: 6 },
  { role: 'code', label: '코드 작업실', x: 15, y: 3, w: 6, h: 3 },
  { role: 'design', label: '디자인 스튜디오', x: 15, y: 6, w: 6, h: 3 },
  { role: 'redaction', label: '글쓰기', x: 1, y: 10, w: 6, h: 3 },
  { role: 'analyse', label: '분석', x: 15, y: 10, w: 4, h: 3 },
  { role: 'chef', label: '팀장 맥스', x: 9, y: 6, w: 4, h: 3 },
];

const furn: Furn[] = [];
const seats: Seat[] = [];

function desk(role: Role, tx: number, ty: number) {
  const id = `desk-${role}-${tx}-${ty}`;
  furn.push({ id, kind: 'desk', tx, ty, w: 2, h: 1, role, seed: tx * 31 + ty });
  furn.push({ id: `chair-${id}`, kind: 'chair', tx, ty: ty - 1, w: 0, h: 0, role });
  seats.push({ id: `seat-${id}`, role, tile: [tx, ty - 1], x: (tx + 1) * T, y: ty * T - 1, deskId: id });
}

// 리서치: 책상 세 개짜리 두 줄(주제마다 리서처 한 명씩, 가장 붐비는 구역)
for (const ty of [5, 8]) for (const tx of [1, 3, 5]) desk('recherche', tx, ty);
// 코드 작업실
for (const tx of [15, 17, 19]) desk('code', tx, 5);
// 디자인 스튜디오
for (const tx of [15, 17]) desk('design', tx, 8);
// 글쓰기
for (const tx of [1, 3, 5]) desk('redaction', tx, 12);
// 분석
for (const tx of [15, 17]) desk('analyse', tx, 12);

// 팀장 책상, 나를 마주 본다
furn.push({ id: 'chefDesk', kind: 'chefDesk', tx: 9, ty: 7, w: 4, h: 1, role: 'chef' });
furn.push({ id: 'chefChair', kind: 'chefChair', tx: 10, ty: 6, w: 0, h: 0, role: 'chef' });
export const CHEF_SEAT: Seat = { id: 'seat-chef', role: 'chef', tile: [10, 6], x: 11 * T, y: 7 * T - 1, deskId: 'chefDesk' };

// 장비와 장식
furn.push({ id: 'rack', kind: 'rack', tx: 14, ty: 3, w: 1, h: 1 });
furn.push({ id: 'printer', kind: 'printer', tx: 12, ty: 4, w: 1, h: 1 });
furn.push({ id: 'cooler', kind: 'cooler', tx: 9, ty: 4, w: 1, h: 1 });
furn.push({ id: 'easel', kind: 'easel', tx: 19, ty: 8, w: 1, h: 1 });
furn.push({ id: 'plant-design', kind: 'plantBig', tx: 20, ty: 8, w: 1, h: 1, seed: 3 });
furn.push({ id: 'plant-entry-l', kind: 'plantTall', tx: 8, ty: 14, w: 1, h: 1, seed: 5 });
furn.push({ id: 'plant-entry-r', kind: 'plantBig', tx: 13, ty: 14, w: 1, h: 1, seed: 9 });
furn.push({ id: 'plant-analyse', kind: 'plantTall', tx: 20, ty: 11, w: 1, h: 1, seed: 11 });
furn.push({ id: 'sofa', kind: 'sofa', tx: 2, ty: 14, w: 3, h: 1 });
furn.push({ id: 'tableLow', kind: 'tableLow', tx: 2, ty: 13, w: 2, h: 0 });
furn.push({ id: 'lamp', kind: 'lamp', tx: 1, ty: 14, w: 1, h: 1 });
furn.push({ id: 'shelf', kind: 'shelf', tx: 5, ty: 14, w: 2, h: 1 });
furn.push({ id: 'coffee', kind: 'coffee', tx: 16, ty: 14, w: 3, h: 1 });
furn.push({ id: 'jukebox', kind: 'jukebox', tx: 14, ty: 14, w: 2, h: 1 });
furn.push({ id: 'plant-coffee', kind: 'plantBig', tx: 19, ty: 14, w: 1, h: 1, seed: 21 });
furn.push({ id: 'lamp-r', kind: 'lamp', tx: 20, ty: 14, w: 1, h: 1 });
furn.push({ id: 'bin', kind: 'bin', tx: 7, ty: 12, w: 0, h: 0 });

export const FURNITURE = furn;
export const SEATS = seats;

/** 중요한 지점. 칸 위에 선 로봇의 발: (x*16+8, y*16+13). */
export const SPOTS = {
  door: [10, 15] as [number, number],
  doorOut: { x: 11 * T, y: 16 * T + 6 },
  /** 맥스가 나를 맞이하고 결과물을 보여 주는 곳 */
  reception: [10, 12] as [number, number],
  receptionPx: { x: 11 * T, y: 12 * T + 13 },
  /** 계획 칠판 앞 */
  board: [10, 3] as [number, number],
  boardPx: { x: 11 * T, y: 3 * T + 13 },
  /** 팀장 책상 앞: 여기서 보고서를 낸다 */
  deliver: [[10, 8], [11, 8], [9, 8], [12, 8], [10, 9], [11, 9]] as [number, number][],
  /** 빈 책상이 없는 팀원용 */
  overflow: [[7, 4], [8, 7], [13, 6], [7, 10], [14, 10], [8, 11], [13, 11], [7, 13]] as [number, number][],
};

/** 뒷벽에 걸린 계획 칠판(픽셀). */
export const BOARD = { x: 128, y: 7, w: 96, h: 35 };
export const WINDOWS = [{ x: 22, y: 8, w: 66, h: 32 }, { x: 264, y: 8, w: 66, h: 32 }];
export const NEON = { x: 97, y: 11 };
export const CLOCK = { x: 232, y: 13 };
export const POSTER = { x: 252, y: 12, w: 10, h: 14 };
export const DOOR = { x: 160, y: 228, w: 32, h: 28 };

/** 걸어갈 수 있는 칸의 격자. */
export function walkGrid(): boolean[][] {
  const g: boolean[][] = [];
  for (let y = 0; y < ROWS; y++) {
    g.push([]);
    for (let x = 0; x < COLS; x++) g[y].push(x >= 1 && x <= 20 && y >= 3 && y <= 14);
  }
  // 문
  g[15][10] = true;
  g[15][11] = true;
  for (const f of FURNITURE) {
    for (let y = f.ty; y < f.ty + f.h; y++) for (let x = f.tx; x < f.tx + f.w; x++) if (g[y]?.[x] !== undefined) g[y][x] = false;
  }
  return g;
}

export const tileFeet = (t: [number, number]) => ({ x: t[0] * T + 8, y: t[1] * T + 13 });
