// Sketch: additive changes to shared/protocol.ts.
// Rule (C1): nothing existing is removed, renamed, or changes meaning. Every new field is optional,
// every new event kind is additive. Old logs (who = 'chef' | 'toolu_…') fold unchanged.
//
// Lines marked "EXISTING +" show a field added to an existing type; the rest are new declarations.

import type { ActKind, FileInfo, MissionInfo, PlanItem, Role } from './protocol.ts';

// ── New domain vocabulary ──

/** Which agent CLI runs a worker. Single list; every Record<AgentKind, …> is completeness-checked by tsc. */
export const AGENT_KINDS = ['claude', 'codex', 'gemini'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/**
 * Where a mission's work happens. Chosen once at `start`, never changes.
 * - folder: today's behaviour. Every worker shares the mission folder (cwd).
 * - repo: a real git repository. Every worker gets its own worktree + branch; the user's checkout is never touched
 *   except by an explicit "합치기" (merge) click with strict preconditions.
 * Absent on old MissionInfo records ⇒ 'folder' (C3).
 */
export type Workspace =
  | { kind: 'folder' }
  | { kind: 'repo'; repo: string; base: string; baseSha: string };

/**
 * Conversational state of one worker. Process liveness (alive vs parked) is NOT here: it is runtime-only and owned by
 * the Runner. This is what the user and Max reason about.
 *
 *   (hire) ──▶ starting ──ready──▶ working ──turn_end(done|implicit)──▶ idle
 *                         │                 │  ▲                                  │
 *                         │                 │  └──────── message delivered ◀──────┤
 *                         │                 ├──turn_end(asked)──▶ waiting ──answer─┘(→ working)
 *                         │                 ├──crash──▶ interrupted ──resume──▶ working
 *                         │                 └──stop──▶ stopped ──message──▶ working
 *                         └──3 launch failures / 2nd crash──▶ failed ──message/retry──▶ working | (new attempt)
 *   any ──release (mission end / close)──▶ gone
 *
 * Legacy in-process subagents (old logs) fold to: hire ⇒ 'working', leave ⇒ 'gone'.
 */
export type WorkerState = 'starting' | 'working' | 'waiting' | 'idle' | 'interrupted' | 'stopped' | 'failed' | 'gone';

/** Derived, never stored (see shared/mission.ts taskStatus). */
export type TaskStatus = 'blocked' | 'ready' | 'running' | 'done' | 'failed' | 'cancelled';

/** Whom a message is from / to. 'chef' = Max, 'user' = 대표님, 'office' = the server itself, else a worker id. */
export type Party = 'user' | 'chef' | 'office' | (string & {});

export type BranchState = 'ready' | 'empty' | 'conflict' | 'merged' | 'archived';

// ── OfficeEvent additions (union members appended to OfficeEvent) ──
export type OfficeEventAdditions =
  /**
   * Upsert of one DAG node, emitted when Max's `plan` tool call is accepted (only for nodes that changed).
   * `key` is Max's stable slug ([a-z0-9-]{1,32}). `after` = keys this task waits for.
   */
  | { k: 'task'; key: string; title: string; role: Role; agent: AgentKind; after: string[]; brief: string; cancelled?: true }
  /**
   * A worker's conversational state changed. `turns` = ids of the msgs (or 'task') that opened the turn now running (a burst is coalesced into one turn),
   * which makes delivery idempotent across crashes (an undelivered msg is one no `worker` event references).
   * `note` is short Korean text for the UI ("시작하지 못했어요 (3번)").
   */
  | { k: 'worker'; who: string; state: WorkerState; turns?: string[]; note?: string }
  /**
   * A message between parties that is not a tool-permission ask.
   * question: worker→chef|user, or chef→user (Max's ask_user). answer: reply to a question (replyTo).
   * followup: new work for a running or finished worker. Never used for user→Max (that stays `start`, C1/gotcha 8).
   */
  | { k: 'msg'; id: string; from: Party; to: Party; kind: 'question' | 'answer' | 'followup'; text: string; replyTo?: string; options?: string[] }
  /** Result of a repo task as a branch. Short branch name only, never a path (C24). */
  | { k: 'branch'; who: string; task: string; branch: string; ahead: number; files: number; state: BranchState };

// EXISTING + optional fields on existing events (old logs simply lack them):
//   hire:  { …, agent?: AgentKind; taskKey?: string }       // absent ⇒ legacy in-process Claude subagent
//   file:  file.branch?: string                             // repo missions: which branch the path belongs to
//   ask:   (unchanged) who is now a worker id or 'chef'     // tool-permission round trip stays `ask`/`ask_done`

// EXISTING + MissionInfo
export interface MissionInfoAdditions {
  /** absent ⇒ { kind: 'folder' } */
  workspace?: Workspace;
}

// EXISTING + Settings (all optional, merged loosely like today)
export interface SettingsAdditions {
  /** default CLI per role; Max may override per task. Missing CLI ⇒ fall back to 'claude' with a note. */
  agentFor?: Partial<Record<Role, AgentKind>>;
  /** max concurrently *working* workers (excludes Max). Default 4, clamp 1..8 (desks + memory). */
  maxWorkers?: number;
  /** repos the user has opened before (absolute, validated), most recent first, max 10 */
  repos?: string[];
}

export interface AgentCliInfo { kind: AgentKind; found: boolean; version?: string; /** Korean, why it can't be used */ problem?: string }

// ── Browser → server (changes) ──
export type ClientMsgChanges =
  /** EXISTING + repo: start a repo mission instead of a folder mission. */
  | { t: 'start'; prompt: string; repo?: string }
  /**
   * EXISTING + to/replyTo. One way to talk to anyone:
   *   to absent | 'chef' → Max (recorded as `start`, unchanged behaviour)
   *   to = worker id     → follow-up or answer to that worker (recorded as `msg`)
   *   replyTo            → answers that question (worker's or Max's ask_user)
   */
  | { t: 'say'; text: string; to?: string; replyTo?: string }
  /** EXISTING + who: stop one worker (absent = whole mission, unchanged). */
  | { t: 'stop'; who?: string }
  /** Repo results. merge = into the user's checkout (strict preconditions); archive = move ref aside, never delete. */
  | { t: 'branch'; missionId: string; branch: string; action: 'merge' | 'archive' }
  /** Read-only diff of a result branch (or one file in it) against the mission base. */
  | { t: 'diff'; missionId: string; branch: string; file?: string };

// ── Server → browser (changes) ──
export type ServerMsgChanges =
  /** EXISTING + agents (claude stays for old clients/tabs). */
  | { t: 'hello'; agents?: AgentCliInfo[] /* … all existing fields … */ }
  | { t: 'diff'; missionId: string; branch: string; file?: string; text: string; truncated: boolean };
// `diff` mutates no mission state, so it needs no replay guard (C6). No other new ServerMsg is added:
// everything mission-shaped travels as OfficeEvent inside the existing `ev`, so replay covers it for free.

// unused-import guard for the sketch
export type _Refs = [ActKind, FileInfo, MissionInfo, PlanItem];
