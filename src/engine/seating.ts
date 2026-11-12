// 일꾼이 어디에 있을지 정하는 순수 함수 하나. 직무와 단계만 보고 자리를 나눠 준다.
//   일하는 중 → 자기 구역 책상 → 빈 책상 아무 데나 → 바닥 자리 → 쌓임(“+N”)
//   쉬는 중(idle, parked, stopped, failed) → 소파와 커피 머신 앞 → 책상 → 바닥 자리 → 쌓임
// 일하는 사람이 먼저 자리를 받으므로, 쉬는 사람이 책상을 먼저 내놓는다. 이미 맞는 자리에 있으면 그대로 둔다.
import type { Role, WorkerPhase } from '../../shared/protocol.ts';
import { LOUNGE_SEATS, LOUNGE_STANDS, SEATS, SPOTS, type Seat } from './layout.ts';

export type Spot = { k: 'seat'; seat: Seat } | { k: 'floor'; tile: [number, number] } | { k: 'stack' };

export interface Roster {
  id: string;
  role: Role;
  phase: WorkerPhase;
  parked?: boolean;
  /** 지금 있는(또는 가는 중인) 자리의 spotKey */
  prev?: string;
}

export const spotKey = (s: Spot) => (s.k === 'seat' ? `seat:${s.seat.id}` : s.k === 'floor' ? `floor:${s.tile.join(',')}` : 'stack');

const RESTING = new Set<WorkerPhase>(['idle', 'stopped', 'failed']);
export const isResting = (w: Pick<Roster, 'phase' | 'parked'>) => !!w.parked || RESTING.has(w.phase);

const seatSpot = (seat: Seat): Spot => ({ k: 'seat', seat });
const floorSpot = (tile: [number, number]): Spot => ({ k: 'floor', tile });

const DESKS = SEATS.map(seatSpot);
const SOFA = LOUNGE_SEATS.map(seatSpot);
const STANDS = LOUNGE_STANDS.map(floorSpot);
const OVERFLOW = SPOTS.overflow.map(floorSpot);
const LOUNGE = [...SOFA, ...STANDS];
const LOUNGE_KEYS = new Set(LOUNGE.map(spotKey));
const DESK_KEYS = new Set(DESKS.map(spotKey));

const desksFor = (role: Role): Spot[] => {
  if (role === 'renfort') return DESKS;
  const own = DESKS.filter((d) => d.k === 'seat' && d.seat.role === role);
  return [...own, ...DESKS.filter((d) => !own.includes(d))];
};

/**
 * 사람마다 받은 자리. `taken` = 이 함수 밖에서 이미 쓰는 자리(옛 방식으로 앉은 로봇)의 spotKey. 쌓인 사람은 { k: 'stack' }.
 * 받을 수 있는 가장 좋은 단계(tier)의 자리 중에서, 이미 있던 자리가 그 단계에 있으면 그대로 두고 아니면 앞에서부터 준다.
 */
export function seatWorkers(workers: readonly Roster[], taken: ReadonlySet<string> = new Set()): Map<string, Spot> {
  const used = new Set(taken);
  const out = new Map<string, Spot>();
  const free = (s: Spot) => !used.has(spotKey(s));
  const give = (w: Roster, tiers: readonly (readonly Spot[])[]) => {
    const tier = tiers.find((t) => t.some(free));
    const spot = tier ? tier.find((s) => spotKey(s) === w.prev && free(s)) ?? tier.find(free)! : { k: 'stack' as const };
    if (spot.k !== 'stack') used.add(spotKey(spot));
    out.set(w.id, spot);
  };
  // 이미 자리가 있는 사람이 먼저: 새로 온 사람 때문에 자리를 옮기지 않는다
  const byPrev = (list: Roster[], has: (key: string) => boolean) => [...list.filter((w) => w.prev && has(w.prev)), ...list.filter((w) => !(w.prev && has(w.prev)))];
  const working = workers.filter((w) => !isResting(w));
  const resting = workers.filter(isResting);
  for (const w of byPrev(working, (k) => DESK_KEYS.has(k))) give(w, [desksFor(w.role), OVERFLOW]);
  for (const w of byPrev(resting, (k) => LOUNGE_KEYS.has(k))) give(w, [LOUNGE, desksFor(w.role), OVERFLOW]);
  return out;
}
