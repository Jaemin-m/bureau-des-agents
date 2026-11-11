// 사무실 기억(React)과 게임 엔진(로봇) 사이의 이벤트 통로.
import type { OfficeEvent } from '../../shared/protocol.ts';

type Fn = (ev: OfficeEvent, live: boolean) => void;

const listeners = new Set<Fn>();
const resetters = new Set<() => void>();

export const bus = {
  on(fn: Fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  emit(ev: OfficeEvent, live: boolean) { for (const fn of listeners) fn(ev, live); },
  /** 새 미션, 다시 보기: 사무실이 비고 맥스는 안내 데스크로 돌아간다 */
  onReset(fn: () => void) { resetters.add(fn); return () => { resetters.delete(fn); }; },
  reset() { for (const fn of resetters) fn(); },
};
