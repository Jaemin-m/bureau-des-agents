// Sketch: server/orchestra/worker.ts (NEW). The worker lifecycle as one pure transition function.
// MissionRun feeds it Runner notes and user/lead commands; it returns the events to record. The fold then applies
// them. So: policy lives here, state lives in the log, and nothing else assigns WorkerState.

import type { OfficeEvent } from '../../shared/protocol.ts';
import type { OfficeEventAdditions, WorkerState } from '../../shared/protocol.additions.ts';
import type { WorkerNode } from '../../shared/mission.ts';
import type { Usage } from '../agents/driver.ts';

type Ev = OfficeEvent | OfficeEventAdditions;

export type WorkerInput =
  | { i: 'turn_started'; refs: string[] }
  | {
      i: 'turn_end'; ok: boolean; interrupted: boolean; text: string; usage: Usage;
      /** facts collected by MissionRun during this turn from the worker's office tool calls */
      asked: boolean; doneReport: string | null; stopAsked: boolean;
    }
  | { i: 'launch_failed'; final: boolean; message: string }
  | { i: 'crashed'; resuming: boolean; message: string }
  | { i: 'context_lost' }
  | { i: 'release' };                                 // mission end / close / server restart cleanup

export interface Step {
  state: WorkerState;
  events: Ev[];
  /** something Max should hear about at his next wake (reports, failures). Derived again from the log after restart. */
  leadWorthy: boolean;
}

/**
 * Transition table (anything not listed is a no-op returning the same state and no events):
 *   (new)       — MissionRun records [hire{agent, taskKey}, worker{starting}] itself before spawning
 *   starting    + turn_started           → working    [worker{working, turns}]
 *   starting    + launch_failed(!final)  → starting   [worker{starting, note:'다시 시작해 볼게요 (n번)'}]
 *   *           + launch_failed(final)   → failed     [worker{failed, note}]                     leadWorthy
 *   idle|waiting|stopped|failed|interrupted + turn_started → working [worker{working, turns}]
 *   gone        + turn_started           → working    [hire (same id: re-entry, fold dedupes), worker{working, turns}]
 *   working     + turn_end(stopAsked|interrupted) → stopped [worker{stopped}]                   leadWorthy
 *   working     + turn_end(asked)        → waiting    [worker{waiting}]                         (the msg is already recorded)
 *   working     + turn_end(ok)           → idle       [report{text: doneReport ?? text} (unless done tool already
 *                                                       recorded it this turn), worker{idle}]   leadWorthy
 *   working     + turn_end(!ok)          → failed     [worker{failed, note:'일하다가 문제가 생겼어요'}] leadWorthy
 *   working     + crashed(resuming)      → interrupted [worker{interrupted, note:'잠깐 끊겼어요. 이어서 할게요.'}]
 *   working     + crashed(!resuming)     → failed     [worker{failed}]                          leadWorthy
 *   *           + context_lost           → (same)     [error{message:'예전 대화를 찾을 수 없어서 요약으로 다시 시작해요.'}]
 *   !gone       + release                → gone       [leave{ok: state==='idle', tokens, tools, ms}]
 *
 * Invariant: `leave` is emitted only by release, so the world's exit animation means "released", never "finished a
 * turn". Finished-but-kept workers are 'idle' (they go to the lounge, not out the door).
 */
export function step(w: WorkerNode, input: WorkerInput, usageSoFar: Usage): Step {
  throw new Error('not implemented');
}
