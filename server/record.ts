// 개발용 녹화: 환경 변수 BUREAU_RECORD=<폴더>를 주면, 미션의 이벤트와 에이전트 프로세스와 오간 줄을 그대로 남긴다.
//   <미션>.logged.jsonl          {"at","ev"}                                미션이 기록한 이벤트(Logged[])
//   <미션>-<n>-<cli>.raw.jsonl   {"dir":"stdout"|"stdin","line":"<원문>"}  n번째로 연 세션과 오간 줄, 순서대로
//   lead-mcp.jsonl               맥스의 MCP 요청마다 메서드와 헤더 몇 개(토큰이 든 경로와 본문은 남기지 않는다)
// 원문에는 사용자의 경로가 들어 있으니 커밋하기 전에 지운다. 변수가 없으면 아무것도 하지 않는다.
import { appendFileSync, mkdirSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import type { Logged } from '../shared/protocol.ts';
import type { RawTap } from './agents/adapter.ts';

const recordDir = () => (process.env.BUREAU_RECORD ? path.resolve(process.env.BUREAU_RECORD) : null);

// 순서가 중요해서 동기로 쓴다. 녹화가 실패해도 미션은 멈추지 않는다
function append(file: string, o: unknown) {
  try { appendFileSync(file, JSON.stringify(o) + '\n'); } catch { /* 녹화는 덤이다 */ }
}

export class Recorder {
  private base: string;
  private sessions = 0;

  constructor(dir: string, missionId: string) {
    mkdirSync(dir, { recursive: true });
    this.base = path.join(dir, missionId);
  }

  logged(l: Logged) { append(`${this.base}.logged.jsonl`, l); }

  /** 세션을 열 때마다 새 파일 하나. */
  session(kind: string): RawTap {
    const file = `${this.base}-${++this.sessions}-${kind}.raw.jsonl`;
    return { raw: (dir, line) => append(file, { dir, line }) };
  }
}

/** BUREAU_RECORD가 없으면 null. */
export function openRecorder(missionId: string): Recorder | null {
  const dir = recordDir();
  if (!dir) return null;
  try { return new Recorder(dir, missionId); } catch { return null; }
}

/** 맥스의 MCP 요청 한 통의 겉모습. 진짜 claude가 Origin을 보내지 않는다는 것을 녹화로 확인하려고 남긴다. */
export function recordLeadRequest(req: IncomingMessage) {
  const dir = recordDir();
  if (!dir) return;
  try { mkdirSync(dir, { recursive: true }); } catch { return; }
  append(path.join(dir, 'lead-mcp.jsonl'), {
    at: Date.now(), method: req.method, origin: req.headers.origin ?? null, host: req.headers.host ?? null,
    contentType: req.headers['content-type'] ?? null, userAgent: req.headers['user-agent'] ?? null,
  });
}
