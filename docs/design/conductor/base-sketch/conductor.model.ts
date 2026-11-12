// server/conductor/model.ts  (SKETCH)
// The data model. One owner: the Conductor (single writer, runs on the Node event loop, so no locks).
// Pure types plus pure helpers. No IO. Persisted as <BUREAU_DIR>/.bureau/missions/<id>.state.json (private, never broadcast).
import type { AgentKind, MissionTarget, Role, TaskResult, TaskState, WorkerPhase } from './shared.protocol.ts';
// TaskState and WorkerPhase are defined ONCE, in shared/protocol.ts (the UI needs them too); the server never redeclares them.
export type { TaskState, WorkerPhase };

// ── identities ────────────────────────────────────────────────────────────────
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };
/** `w-<n>-<rand4>`: [\w-] only (version filenames, C5), never `demo-` prefixed, minted by the Conductor, never by a model. */
export type WorkerId = Brand<string, 'WorkerId'>;
/** `'chef'` stays Max's `who` forever (C22, C1). Legacy `toolu_…` ids only exist in old logs and never reach this module. */
export type Who = 'chef' | WorkerId;
/** Chosen by Max in office_plan (`[a-z0-9-]{1,32}`, unique per mission). The key IS the id; no second id to map. */
export type TaskKey = Brand<string, 'TaskKey'>;
export type MessageId = Brand<string, 'MessageId'>;
export type AbsPath = Brand<string, 'AbsPath'>;

// ── tasks: the DAG ───────────────────────────────────────────────────────────
export type Access = 'write' | 'read'; // 'read' = research/review: no Write/Edit, codex read-only sandbox, no worktree needed

export interface TaskSpec {
  key: TaskKey;
  title: string;          // <= 60 chars, shown on the board
  brief: string;          // self-contained instruction (Max writes it; <= 6000 chars)
  role: Exclude<Role, 'chef'>;
  agent: AgentKind;
  access: Access;
  after: TaskKey[];       // dependencies, must already exist or be in the same plan call
  pin?: WorkerId;         // follow-up work: run on this worker (same session, same workspace)
}

/**
 * TaskState meanings (union lives in shared/protocol.ts):
 * waiting  deps not all done
 * ready    deps done; waits for a slot / for its pinned worker; also where a restart puts interrupted work (no extra 'paused' state)
 * running  a worker owns it
 * blocked  a dependency failed or was cancelled; surfaced to Max, resolved by cancel / re-plan / retry
 * done | failed | cancelled   terminal (retry = new attempt on the same key: failed -> ready)
 */

export interface Task {
  spec: TaskSpec;
  state: TaskState;
  worker?: WorkerId;
  /** consecutive start failures; >= 3 => failed (Orca's circuit breaker) */
  attempts: number;
  result?: TaskResult;
  note?: string;
  origin: 'plan' | 'followup';
}

// ── workers: long-lived seats, not per-task ──────────────────────────────────
/** A session is bound to the cwd it was created in (gemini resume is per-cwd, codex --last is cwd-filtered). */
export interface SessionRef { readonly cli: AgentKind; readonly id: string; readonly cwd: AbsPath }

export type WorkspaceRef =
  | { kind: 'folder'; root: AbsPath }                                  // mission folder (shared, as today)
  | { kind: 'readonly'; root: AbsPath }                                // repo root, read-only
  | { kind: 'worktree'; repo: AbsPath; path: AbsPath; branch: string; base: string; state: 'planned' | 'ready' | 'retained' | 'retired' };

export type Block =
  | { reason: 'approval'; approvalId: string }
  | { reason: 'question'; questionId: MessageId };

interface WorkerBase {
  id: Who;
  agent: AgentKind;
  role: Role;
  name: string;
  workspace: WorkspaceRef | null;     // null only for 'chef'
  session?: SessionRef;               // learned from the CLI (or pre-assigned for claude/gemini)
  /** bumped on every open_session; late signals from an older process carry an older gen and are dropped (today's `cur.live?.proc === proc` guard) */
  gen: number;
  /** orthogonal to phase: is a process currently held? ('parked' = released, session ref kept) */
  residency: 'live' | 'parked';
  proc?: { pid: number; startedAt: number };   // so a restart can reap orphans
  inbox: Message[];                   // not yet delivered; drained into the next turn
  startFailures: number;
  lastSignalAt: number;
}

/** Invariants in types: 'working' always has a task and a turn; 'blocked' always says on what. */
export type Worker = WorkerBase & (
  | { phase: 'provisioning' | 'starting'; taskKey?: TaskKey }
  | { phase: 'working'; taskKey?: TaskKey; turnStartedAt: number }      // chef has no taskKey
  | { phase: 'blocked'; taskKey?: TaskKey; on: Block }
  | { phase: 'idle' | 'stopping' | 'stopped' | 'failed' | 'retired' }
);

/** Legal moves. `moveTo` throws on anything else, a test enumerates the full matrix. One source for reducer, UI badges and docs. */
export const NEXT_PHASE: Record<WorkerPhase, readonly WorkerPhase[]> = {
  provisioning: ['starting', 'failed', 'stopped', 'retired'],
  starting: ['working', 'failed', 'stopped'],
  working: ['blocked', 'idle', 'stopping', 'failed'],
  blocked: ['working', 'stopping', 'failed', 'idle'],
  idle: ['working', 'starting', 'retired'],        // 'starting' = reopen after park/restart
  stopping: ['stopped', 'failed'],
  stopped: ['starting', 'retired'],
  failed: ['starting', 'retired'],
  retired: [],
};
export function moveTo<W extends Worker>(w: W, to: WorkerPhase): W { throw new Error('not implemented'); }

// ── messages & questions ─────────────────────────────────────────────────────
export interface Message { id: MessageId; at: number; from: Who | 'user' | 'office'; to: Who; kind: 'brief' | 'followup' | 'answer' | 'note' | 'news'; text: string; replyTo?: MessageId }

/**
 * A worker's question ("ask") or the office's escalation of it. Distinct from an approval: approvals are
 * mid-turn tool permissions (Block.reason 'approval'); questions end the worker's turn (Orca's non-blocking ask).
 * First answer wins; later ones become plain notes. That is the whole concurrency story for "user and Max both reply".
 */
export interface Question {
  id: MessageId; from: WorkerId; text: string; options?: string[];
  audience: 'lead' | 'user';          // starts 'lead'; auto-escalates to 'user' when Max's next turn ends without answering
  state: 'open' | 'answered' | 'void';
  answer?: { by: 'user' | 'chef'; text: string; at: number };
}

/** What the lead hasn't been told yet. Appended by the reducer, flushed (drained) into one wake message. At-least-once: ids are in the text. */
export interface NewsItem { id: string; at: number; line: string }

// ── the mission ──────────────────────────────────────────────────────────────
export type MissionStatus = 'working' | 'done' | 'stopped' | 'error';
export type ServerTarget =
  | { kind: 'folder'; root: AbsPath }
  | { kind: 'repo'; root: AbsPath; baseBranch: string; baseSha: string; worktreeRoot: AbsPath };

export interface Limits { maxLive: number; maxWorkers: number; maxTasks: number; parkAfterMs: number; startFailureLimit: number; newsDebounceMs: number }

export interface MissionState {
  v: 1;
  missionId: string;
  status: MissionStatus;
  target: ServerTarget;
  publicTarget: MissionTarget;
  /** Monotone counter: ids (w-<seq>, q-<seq>), news ids. Persisted, so ids never repeat after a restart. */
  seq: number;
  tasks: Record<TaskKey, Task>;
  workers: Record<string, Worker>;       // includes 'chef'
  questions: Record<string, Question>;
  news: NewsItem[];
  newsSince: number | null;              // when the oldest unflushed news arrived (debounce base)
  limits: Limits;
}

export function newMission(missionId: string, target: ServerTarget, limits: Limits, now: number): MissionState { throw new Error('not implemented'); }
