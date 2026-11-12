// SKETCH of the additive changes to shared/protocol.ts (and a few shared/activity.ts constants).
// Rule C1: nothing existing is removed, renamed or re-meant. Every new field is optional, every new kind is additive.
// Unknown kinds are already no-ops in store.apply / World.apply / Director.event (C2), so old clients survive new logs.
import type { OfficeEvent as LegacyOfficeEvent, MissionInfo as LegacyMissionInfo, ClientMsg as LegacyClientMsg, ServerMsg as LegacyServerMsg, Role, ActKind, PlanItem, Quota } from 'bureau/protocol.ts';

/** Which CLI really runs a worker. Orthogonal to Role (C21): Role = desk/sprite/name pool, AgentKind = badge + adapter. */
export type AgentKind = 'claude' | 'codex' | 'gemini';

/** Wire form of the worker phase (the server's richer `Worker` union collapses to this for the UI). */
export type WorkerPhase = 'provisioning' | 'starting' | 'working' | 'blocked' | 'idle' | 'stopping' | 'stopped' | 'failed' | 'retired';
export type BlockReason = 'approval' | 'question';
export type TaskState = 'waiting' | 'ready' | 'running' | 'blocked' | 'done' | 'failed' | 'cancelled';

export interface TaskResult {
  /** worker's own summary (handback), cut to 4000 chars; full text is in the `msg`/`report` events */
  summary: string;
  /** repo missions only. Never an absolute path (C24): branch names and counts only. */
  branch?: string;
  base?: string; // short sha the branch was cut from
  head?: string; // short sha of the checkpoint commit
  files?: number; ins?: number; del?: number;
  mergeable?: 'clean' | 'conflict' | 'unknown';
  merged?: boolean;
}

export type MissionTarget =
  | { kind: 'folder' }
  /** `label` is what the UI shows ("shop"); the absolute repo path lives server-side only. */
  | { kind: 'repo'; label: string; baseBranch: string };

/** New optional fields on existing structures. */
export interface MissionInfoExt { target?: MissionTarget }
export interface HireExt { agent?: AgentKind; taskKey?: string }
export interface AskExt {
  /** 'approval' (default, legacy) = tool permission, answered with {t:'answer'}; 'question' = free text, answered with {t:'reply'} */
  kind?: 'approval' | 'question';
  options?: string[];
}
export interface EndExt { /** workers stay seated (long-lived); world must not walk them out and store must keep open asks */ stay?: boolean }

export type NewOfficeEvent =
  /** worker phase change. Idempotent: the store sets the phase, never toggles. */
  | { k: 'worker'; id: string; phase: WorkerPhase; block?: BlockReason; taskKey?: string; parked?: boolean; note?: string }
  /** DAG node upsert: full node every time, so folding twice equals folding once. */
  | { k: 'task'; key: string; title: string; after: string[]; state: TaskState; worker?: string; agent?: AgentKind; role?: Role; result?: TaskResult; note?: string }
  /** a message in a thread: user<->worker, worker->lead, lead->worker. `kind:'brief'` is the first instruction. NOT `start` (gotcha 8). */
  | { k: 'msg'; id: string; from: string; to: string; kind: 'brief' | 'followup' | 'answer' | 'note' | 'news'; text: string; replyTo?: string };

export type OfficeEvent = LegacyOfficeEvent | NewOfficeEvent;
export type MissionInfo = LegacyMissionInfo & MissionInfoExt;

export interface AgentInfo { kind: AgentKind; found: boolean; version?: string; /** shown in the picker so the user knows which vendor sees what (C25) */ vendor: string; caps: { approvals: boolean; steer: boolean; web: boolean } }

// ── browser -> server (all additive; old shapes unchanged) ──
export type NewClientMsg =
  /** repo target is optional; absent = today's mission folder */
  | { t: 'start'; prompt: string; target?: { repo: string } }
  /** `to` = worker id; absent = Max (today) */
  | { t: 'say'; text: string; to?: string }
  | { t: 'reply'; requestId: string; text: string }
  | { t: 'stop'; who?: string }
  | { t: 'retire'; who: string }
  | { t: 'resume' }
  | { t: 'repo_check'; path: string }
  | { t: 'merge'; taskKey: string }      // unit U13
  | { t: 'discard_branch'; taskKey: string; confirmSha: string }; // unit U13
export type ClientMsg = LegacyClientMsg | NewClientMsg; // (real file: edit the union members in place; shown separately here)

export type NewServerMsg =
  | { t: 'repo_info'; path: string; ok: boolean; label?: string; branch?: string; dirty?: boolean; why?: string };
export type ServerMsg = LegacyServerMsg | NewServerMsg;
// hello gains `agents?: AgentInfo[]` (hello.claude stays for old tabs). Quota gains `quotas?: Partial<Record<AgentKind, Quota>>` later.
export type { PlanItem, Quota, Role, ActKind };

/**
 * Pure and shared: keeps `hello` restore correct once the log passes MAX_LOG (gotcha 9).
 * Drops only events that cannot change roster/tasks/asks (typing is never logged; old act/act_done/say/think pairs older than `keepTail`).
 * Property to test: fold(compactLog(log)) and fold(log) agree on agents, tasks, asks, plan, files, end.
 */
export function compactLog<T extends { ev: OfficeEvent }>(log: readonly T[], keepTail: number): T[] {
  throw new Error('not implemented');
  // TODO: walk once from the end; keep every structural kind (hire, leave, task, worker, msg, report, plan(last only), file, ask w/o matching ask_done, end, start)
  //       keep last `keepTail` events of any kind; drop act/act_done/say/think/init that are older and whose pair is closed.
}
