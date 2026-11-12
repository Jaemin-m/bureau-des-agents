// server/conductor/dag.ts (SKETCH): pure graph helpers used by step.ts. ~60 lines in the real file.
import type { TaskSpec, TaskKey, Task } from './conductor.model.ts';

export type PlanError = { code: 'dup_key' | 'bad_key' | 'unknown_dep' | 'cycle' | 'too_many' | 'bad_agent' | 'bad_pin'; key?: TaskKey; msg: string };

/** All-or-nothing validation of an office_plan call against existing tasks. Messages are Korean (they come back to Max, who may quote them to the user). */
export function validatePlan(existing: Readonly<Record<string, Task>>, specs: readonly TaskSpec[], max: number): PlanError | null {
  throw new Error('not implemented');
  // TODO: Kahn's algorithm over existing ∪ specs; report the cycle's keys.
}
/** Tasks whose every dependency is done. Order: key order (deterministic => testable). */
export function readySet(tasks: Readonly<Record<string, Task>>): TaskKey[] { throw new Error('not implemented'); }
export function dependentsOf(tasks: Readonly<Record<string, Task>>, key: TaskKey): TaskKey[] { throw new Error('not implemented'); }
/** For the board: topological order with depth, so the UI can indent "after X". */
export function layers(tasks: Readonly<Record<string, Task>>): { key: TaskKey; depth: number }[] { throw new Error('not implemented'); }
