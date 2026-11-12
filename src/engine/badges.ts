// 로봇 머리 옆의 작은 배지 둘: 오른쪽은 일꾼을 돌리는 CLI(색 점), 왼쪽은 지금 단계(?, !, 체크, zZ, 가위표, 점 셋).
// 전부 픽셀 몇 개를 코드로 찍는다. 스프라이트는 한 번만 만들어 둔다.
import type { AgentKind, BlockReason, WorkerPhase } from '../../shared/protocol.ts';
import { KIND } from './kinds.ts';
import { fromRows, P, rect, type G } from './pixels.ts';

export type PhaseBadge = 'question' | 'approval' | 'idle' | 'parked' | 'failed' | 'dots';

/** 지금 단계에 맞는 배지. 일하는 중과 옛 기록의 로봇은 없다(타자 치는 모습이 그대로 배지다). */
export function phaseBadge(phase: WorkerPhase | null, block?: BlockReason, parked?: boolean): PhaseBadge | null {
  if (!phase) return null;
  if (parked) return 'parked';
  switch (phase) {
    case 'blocked': return block === 'question' ? 'question' : 'approval';
    case 'idle': return 'idle';
    case 'failed': return 'failed';
    case 'provisioning': case 'starting': return 'dots';
    default: return null;
  }
}

const PAL = { i: P.ink, y: '#ffd166', o: '#ff8a3d', g: '#3ddc97', r: '#ff6b6b', b: '#9fe3ff' };

/** 검은 바탕에 색 글자: 어떤 바닥 위에서도 읽힌다. */
const SPRITES: Record<Exclude<PhaseBadge, 'dots'>, string[]> = {
  question: ['iiiii', 'iyyii', 'iiiyi', 'iiyii', 'iiiii', 'iiyii', 'iiiii'],
  approval: ['iiiii', 'iioii', 'iioii', 'iioii', 'iiiii', 'iioii', 'iiiii'],
  idle: ['iiiii', 'iiigi', 'igigi', 'iigii', 'iiiii'],
  parked: ['iiiiiii', 'iiibbbi', 'iiiibii', 'ibbbbbi', 'iibiiii', 'ibbbiii', 'iiiiiii'],
  failed: ['iiiii', 'iriri', 'iirii', 'iriri', 'iiiii'],
};

const cache = new Map<string, HTMLCanvasElement>();
function sprite(key: keyof typeof SPRITES): HTMLCanvasElement {
  let c = cache.get(key);
  if (!c) { c = fromRows(SPRITES[key], PAL); cache.set(key, c); }
  return c;
}

/** (x, y) = 로봇의 발. 머리 왼쪽 위 모서리 바깥에 붙인다. t = 세계 시간(초). */
export function drawPhaseBadge(g: G, badge: PhaseBadge, x: number, y: number, t: number) {
  if (badge === 'dots') {
    const left = x - 16, top = y - 21;
    rect(g, left, top, 9, 4, P.ink);
    for (let i = 0; i < 3; i++) rect(g, left + 1 + i * 3, top + 1, 2, 2, Math.floor(t * 3) % 3 === i ? '#ffffff' : '#6b6580');
    return;
  }
  const c = sprite(badge);
  g.drawImage(c, Math.round(x) - 7 - c.width, Math.round(y) - 23 + ((7 - c.height) >> 1));
}

/** 머리 오른쪽 위 모서리 바깥의 CLI 색 점(4 × 4, 검은 테두리). (x, y) = 로봇의 발. */
export function drawKindChip(g: G, kind: AgentKind, x: number, y: number) {
  rect(g, Math.round(x) + 6, Math.round(y) - 22, 4, 4, P.ink);
  rect(g, Math.round(x) + 7, Math.round(y) - 21, 2, 2, KIND[kind].color);
}
