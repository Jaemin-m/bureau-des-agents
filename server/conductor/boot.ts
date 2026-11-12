// 서버가 다시 켜질 때: 저장한 제어 상태를 읽고, 죽은 서버가 남긴 CLI 프로세스를 끝낸다.
// 남은 프로세스를 그대로 두면, 곧 같은 세션을 이어갈 새 프로세스와 함께 같은 폴더를 고친다.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { MissionState } from './model.ts';

/** 띄운 프로세스. 프로세스 그룹의 우두머리로 띄우므로 pid가 곧 그룹 id다 */
export interface ProcRecord { pid: number; bin: string }
export interface Usage { tokens: number; tools: number; ms: number }

/** `.bureau/missions/<id>.state.json`의 모양. 브라우저로 가지 않는다(세션 id, 경로, pid가 들어 있다) */
export interface Saved {
  v: 1;
  mission: MissionState;
  /** 일꾼 id(또는 chef) → 지금 쥐고 있는 프로세스 */
  procs: Record<string, ProcRecord>;
  /** 일꾼이 떠날 때 leave에 싣는 누적 사용량 */
  usage: Record<string, Usage>;
}

export function loadSaved(file: string): Saved | null {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  const s = raw as Partial<Saved> | null;
  if (!s || s.v !== 1 || !s.mission || typeof s.mission !== 'object') return null;
  return { v: 1, mission: s.mission, procs: s.procs ?? {}, usage: s.usage ?? {} };
}

function psLine(pid: number): Promise<{ pgid: number; command: string } | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'pgid=,command=', '-p', String(pid)], { timeout: 5000 }, (err, out) => {
      const m = /^\s*(\d+)\s+(.*)$/.exec(out.trim());
      resolve(err || !m ? null : { pgid: Number(m[1]), command: m[2] });
    });
  });
}

/** 같은 pid가 다른 프로그램에 다시 쓰였을 수 있다: 그룹 우두머리이고 명령에 기록한 실행 파일 이름이 있어야 우리 것이다 */
export async function isOurs(p: ProcRecord): Promise<boolean> {
  if (!Number.isInteger(p.pid) || p.pid <= 1 || p.pid === process.pid) return false;
  const ps = await psLine(p.pid);
  return !!ps && ps.pgid === p.pid && ps.command.includes(path.basename(p.bin));
}

const groupAlive = (pgid: number) => {
  try { process.kill(-pgid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
};

async function gone(pgid: number, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (!groupAlive(pgid)) return true;
  return !groupAlive(pgid);
}

/** 기록한 프로세스 중 아직 살아 있는 우리 것의 그룹을 끝낸다(SIGTERM, 안 되면 SIGKILL). 끝낸 pid를 돌려준다. */
export async function reapOrphans(procs: readonly ProcRecord[]): Promise<number[]> {
  const reaped: number[] = [];
  for (const p of procs) {
    if (!(await isOurs(p))) continue;
    try { process.kill(-p.pid, 'SIGTERM'); } catch { continue; }
    if (!(await gone(p.pid, 3000))) {
      try { process.kill(-p.pid, 'SIGKILL'); } catch { /* 그사이 끝났다 */ }
      await gone(p.pid, 1000);
    }
    reaped.push(p.pid);
  }
  return reaped;
}
