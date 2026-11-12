// Sketch: server/orchestra/board.ts (NEW). Pure policy over MissionView: plan validation, scheduling, completion,
// and the text Max reads. No I/O, no clocks (time passed in), so `node --test` covers it without any CLI.

import type { OfficeEvent, Role } from '../../shared/protocol.ts';
import type { AgentKind, OfficeEventAdditions, Workspace } from '../../shared/protocol.additions.ts';
import type { MissionView } from '../../shared/mission.ts';

type Ev = OfficeEvent | OfficeEventAdditions;

/** Max's `plan` tool input after JSON-schema parsing (untrusted values still; validated here). */
export interface PlanInput {
  tasks?: { key: string; title: string; brief: string; role: Role; agent?: AgentKind; after?: string[] }[];
  /** stop + cancel these (running workers are stopped, not-started tasks never start) */
  cancel?: string[];
  /** start a fresh attempt (new worker) for these failed/stopped tasks */
  retry?: string[];
}

export interface PlanContext {
  workspace: Workspace;
  installed: Record<AgentKind, boolean>;
  agentFor: Partial<Record<Role, AgentKind>>;
}

export type PlanResult =
  /** events to record (only changed nodes) + Korean text returned to Max as the tool result */
  | { ok: true; events: Ev[]; stop: string[]; reply: string }
  /** nothing recorded; Max gets the reason and can call again */
  | { ok: false; reply: string };

/**
 * Validate and diff a plan against the current view. All-or-nothing.
 * Rejects (Korean reason): bad key ([a-z0-9-]{1,32}), unknown role (chef not allowed), dep on unknown key,
 * a cycle (DFS over existing ∪ new edges), changing title/brief/role/agent/after of a task whose status is not
 * 'blocked'|'ready' ("이미 시작한 일은 바꿀 수 없어요. message로 지시하세요."), retry of a task that is not failed/stopped.
 * Defaults: agent = input.agent ?? agentFor[role] ?? 'claude'; an agent that is not installed falls back to 'claude'
 * and the reply says so. Same plan sent twice ⇒ ok with zero events (idempotent).
 */
export function validatePlan(v: MissionView, ctx: PlanContext, input: PlanInput, now: number): PlanResult {
  throw new Error('not implemented');
}

export interface Limits { maxWorkers: number }

export type Decision =
  /** start a new attempt for a ready task; workerId minted as `w-<key>-<n>` ([\w-], never 'demo-', C5) */
  | { d: 'launch'; task: string; workerId: string }
  /** wake Max with a digest because something needs the lead */
  | { d: 'wake_lead' }
  /** nothing running, nothing ready, nothing open, Max idle: end the mission with Max's last words */
  | { d: 'finish'; ok: boolean };

/**
 * Called after every recorded event that can change readiness (task, worker, report, msg, ask_done) and after Max's
 * turn ends. Pure: the same view always yields the same decisions, so calling it twice is harmless as long as the
 * caller records `hire` + `worker{state:'starting'}` before spawning (the task is then 'running', not 'ready').
 *
 * TODO
 *   working = workers in starting|working (Max excluded)
 *   for task in taskOrder where taskStatus==='ready' (plan order = priority) while working < maxWorkers: launch
 *   leadNeeded = unseen reports/questions-to-chef/failures since lead's last wake (cursor passed in)
 *   if leadNeeded && leadIdle: wake_lead
 *   if no task running|ready, no open asks, no open questions, no live worker turn, leadIdle, !leadNeeded:
 *     finish{ok: every non-cancelled task done}
 */
export function schedule(v: MissionView, limits: Limits, lead: { idle: boolean; seenUpTo: number }, logLength: number): Decision[] {
  throw new Error('not implemented');
}

/**
 * The text Max receives when woken (Korean, terse, ≤ ~1500 chars + full reports as attachments-in-text):
 *   "[사무실 소식]\n- 아이리스(research): 끝났어요. 보고서: …\n- 에이다(build): 질문이 있어요 (q-12): …\n
 *    보드: 완료 2 · 진행 1 · 대기 1 · 막힘 0\n할 일: 질문에 답하거나(message), 새 일을 계획하거나(plan), 다 끝났으면 finish."
 * After a server restart there is no cursor: `since = 0` produces a full status digest (derivable, so not persisted).
 */
export function digest(v: MissionView, since: number): string {
  throw new Error('not implemented');
}
