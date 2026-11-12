// Sketch: shared/mission.ts (NEW). The single fold from OfficeEvent[] to orchestration state.
//
// Load-bearing decision: the mission's JSONL log is the source of truth for every *public* orchestration fact
// (DAG, worker states, messages, asks, branches). The server folds it to decide; the browser folds it to draw.
// Same function, same input ⇒ live view, late tab (`hello`), replay, demo, and post-crash restore cannot disagree.
// Private runtime facts (resume tokens, absolute worktree paths, pids) live in the server ledger, not here.
//
// Pure, no I/O, erasable syntax only (runs under Node type stripping and Vite).

import type { OfficeEvent, Role } from './protocol.ts';
import type { AgentKind, BranchState, Party, TaskStatus, WorkerState } from './protocol.additions.ts';

export interface TaskNode {
  key: string;
  title: string;
  role: Role;
  agent: AgentKind;
  after: string[];
  brief: string;
  cancelled: boolean;
  /** worker ids in attempt order (from hire.taskKey) */
  attempts: string[];
  plannedAt: number;
}

export interface WorkerNode {
  id: string;
  name: string;
  role: Role;
  /** undefined ⇒ legacy in-process Claude subagent from an old log */
  agent?: AgentKind;
  taskKey?: string;
  state: WorkerState;
  /** ever delivered a report (done tool or implicit turn-end report) */
  reported: boolean;
  lastReport: string;
  /** msg ids (or 'task') that have opened a turn: delivery ledger for idempotent redelivery */
  turns: string[];
  note?: string;
  since: number;
}

export interface MsgNode { id: string; from: Party; to: Party; kind: 'question' | 'answer' | 'followup'; text: string; replyTo?: string; options?: string[]; at: number }

export interface AskNode { requestId: string; who: string; at: number }

export interface BranchNode { who: string; task: string; branch: string; ahead: number; files: number; state: BranchState }

export interface MissionView {
  tasks: Record<string, TaskNode>;
  taskOrder: string[];
  workers: Record<string, WorkerNode>;
  workerOrder: string[];
  msgs: Record<string, MsgNode>;
  msgOrder: string[];
  /** open tool-permission asks, keyed by requestId (fixes world ask_done-by-first-actor bug, gotcha 7) */
  asks: Record<string, AskNode>;
  branches: Record<string, BranchNode>;
  /** true after `end` until the next `start` / worker re-entry */
  ended: boolean;
}

export const emptyView = (): MissionView => ({
  tasks: {}, taskOrder: [], workers: {}, workerOrder: [], msgs: {}, msgOrder: [], asks: {}, branches: {}, ended: false,
});

/**
 * Apply one event. Returns a new object only for slices that changed (structural sharing), so zustand selectors stay
 * cheap and the server can use the same function. Idempotent for re-delivered structural events:
 *   - hire of a known id re-enters the worker (state → 'working') without duplicating workerOrder (gotcha 3);
 *   - task upsert with identical fields is a no-op.
 * Unknown kinds return `v` unchanged (C2).
 */
export function foldMission(v: MissionView, ev: OfficeEvent | import('./protocol.additions.ts').OfficeEventAdditions, at: number): MissionView {
  // TODO
  // switch (ev.k):
  //  'start'    → ended=false
  //  'hire'     → upsert WorkerNode{agent: ev.agent, taskKey: ev.taskKey, state:'working'}; if new push workerOrder;
  //               if ev.taskKey push id to tasks[taskKey].attempts (dedupe)
  //  'worker'   → workers[who].state = ev.state; note; push each of ev.turns (dedupe); since = at
  //  'report'   → workers[who].reported = true; lastReport = text  (legacy and new alike)
  //  'leave'    → workers[who].state = 'gone'
  //  'task'     → upsert TaskNode (keep attempts), push taskOrder if new
  //  'msg'      → msgs[id] = node (dedupe by id)
  //  'ask'      → asks[requestId] = {who}; 'ask_done' → delete asks[requestId]
  //  'branch'   → branches[branch] = node
  //  'end'      → ended = true; asks = {} (mirrors today's store behaviour)
  throw new Error('not implemented');
}

// ── Derived selectors (never stored anywhere) ──

/**
 * cancelled → 'cancelled'
 * some attempt reported → 'done'
 * some attempt in starting|working|waiting|interrupted → 'running'
 * any dep not 'done' → 'blocked' (a dep 'failed'|'cancelled' keeps it blocked; Max must replan or cancel)
 * last attempt failed|stopped and no live attempt → 'failed'
 * else → 'ready'
 */
export function taskStatus(v: MissionView, key: string): TaskStatus {
  throw new Error('not implemented');
}

/** Questions with no answer yet (msg.kind==='question' and no msg with replyTo === id). */
export function openQuestions(v: MissionView, to?: Party): MsgNode[] {
  throw new Error('not implemented');
}

/** Follow-ups/answers addressed to a worker that no `worker.turns` has consumed yet (redelivery after crash). */
export function undelivered(v: MissionView, workerId: string): MsgNode[] {
  throw new Error('not implemented');
}

/** Longest-path depth per task for the board/DAG drawing (cycle-free by construction: validatePlan rejects cycles). */
export function layers(v: MissionView): string[][] {
  throw new Error('not implemented');
}

/** Worker that a party string refers to, accepting id, display name, or task key (Max writes names). */
export function resolveWorker(v: MissionView, ref: string): WorkerNode | null {
  throw new Error('not implemented');
}
