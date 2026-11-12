// 개발용 녹화: 환경 변수 BUREAU_RECORD=<폴더>를 주면, claude 프로세스와 오가는 줄을 그대로 남긴다.
//   <미션>-<n>.raw.jsonl     {"dir":"stdout"|"stdin","line":"<원문 한 줄>"}  오간 순서대로
//   <미션>-<n>.logged.jsonl  {"at","ev","from"}                           미션이 기록한 이벤트
// 한 쌍이 골든 픽스처다(claude가 한 말 → 사무실 이벤트). 원문에는 사용자의 경로가 들어 있으니 커밋하기 전에 지운다.
// 변수가 없으면 아무것도 하지 않는다.
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Logged } from '../shared/protocol.ts';

/** 이벤트를 만든 쪽: 번역기가 claude의 말에서 만들었는가, 서버가 직접 기록했는가. */
export type LoggedFrom = 'normalizer' | 'bureau';

export class WireTap {
  private base: string;

  constructor(dir: string, missionId: string, n: number) {
    mkdirSync(dir, { recursive: true });
    this.base = path.join(dir, `${missionId}-${n}`);
  }

  raw(dir: 'stdout' | 'stdin', line: string) {
    this.append('.raw.jsonl', { dir, line });
  }

  logged(l: Logged, from: LoggedFrom) {
    this.append('.logged.jsonl', { at: l.at, ev: l.ev, from });
  }

  // 순서가 중요해서 동기로 쓴다. 녹화가 실패해도 미션은 멈추지 않는다
  private append(ext: string, o: unknown) {
    try { appendFileSync(this.base + ext, JSON.stringify(o) + '\n'); } catch { /* 녹화는 덤이다 */ }
  }
}

/** BUREAU_RECORD가 없으면 null. */
export function openTap(missionId: string, n: number): WireTap | null {
  const dir = process.env.BUREAU_RECORD;
  if (!dir) return null;
  try { return new WireTap(path.resolve(dir), missionId, n); } catch { return null; }
}
