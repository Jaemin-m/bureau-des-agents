// Sketch: server/orchestra/ledger.ts (NEW). Private runtime facts the browser must never see and the log must not carry.
// File: <BUREAU_DIR>/.bureau/missions/<missionId>.ledger.json, atomic write (tmp + rename), written by MissionRun only.
//
// Split of truth (each fact has exactly one home):
//   log (public)   : what happened — tasks, worker states, messages, asks, reports, branches (names only)
//   ledger (secret): how to get back to it — resume tokens, absolute cwd/worktree paths, last pid + bin
//   MissionInfo    : registry card — title, folder, status, workspace, stats, files (as today)
// Legacy: MissionInfo.sessionId (Max) is read once into ledger.lead.resume on restore and no longer written.

import type { ResumeToken } from '../agents/driver.ts';
import type { WorktreeRef } from '../git/worktrees.ts';

export interface LedgerEntry {
  resume?: ResumeToken;
  cwd: string;
  worktree?: WorktreeRef;
  /** for the restart reaper: kill only if the pid is alive AND its command line contains `bin` */
  pid?: number;
  bin?: string;
}

export interface Ledger {
  version: 1;
  lead: LedgerEntry & { lens?: string };
  workers: Record<string, LedgerEntry>;
}

/** Order rule: put() is awaited BEFORE the corresponding spawn / worktree creation, so a crash never leaves an
 *  untracked process or directory (restore() can always find what it must reap or adopt). */
export interface LedgerStore {
  read(): Promise<Ledger>;
  put(who: 'lead' | string, patch: Partial<LedgerEntry & { lens?: string }>): Promise<void>;
  flushSync(): void;
}

export function ledgerStore(file: string): LedgerStore { throw new Error('not implemented'); }
