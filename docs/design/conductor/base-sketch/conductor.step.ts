// server/conductor/step.ts  (SKETCH): the functional core. Pure: no fs, no timers, no processes, no Date.now().
//
//   step(state, input, ctx) -> { state, events, effects, reply }
//
// 1. APPLY the input to the facts (state).     "what happened / what was asked"
// 2. CONVERGE: derive effects from state alone.  "what must be true now"  (level-triggered, like a controller loop)
// Crash recovery is therefore: load state.json, feed {k:'boot'}, execute whatever converge says. No replay of history.
// Every effect is keyed (effectKey) and idempotent; `ctx.inflight` stops converge from re-emitting one that is running.
import type { OfficeEvent } from './shared.protocol.ts';
import type { MissionState, TaskSpec, TaskKey, Who, WorkerId, MessageId, AbsPath, SessionRef, Access } from './conductor.model.ts';
import type { WorkerSignal, TurnInput, Capabilities } from './agents.adapter.ts';
import type { WorkspaceSpec } from './workspaces.ts';
import type { AgentKind } from './shared.protocol.ts';

export type Input =
  | { k: 'boot' }                                                    // after load: demote anything that was live; see converge step 0
  | { k: 'user_said'; to: Who; text: string; replyTo?: MessageId }
  | { k: 'user_stop'; who?: Who }
  | { k: 'user_retire'; who: WorkerId }
  | { k: 'user_resume' }
  | { k: 'lead_plan'; specs: TaskSpec[] }                             // from office_plan (validated here, not in the MCP layer)
  | { k: 'lead_message'; to: WorkerId; text: string; replyTo?: MessageId }
  | { k: 'lead_cancel'; target: { task: TaskKey } | { worker: WorkerId } }
  | { k: 'signal'; who: Who; gen: number; sig: WorkerSignal }         // gen mismatch => dropped
  | { k: 'effect_done'; key: string; r: EffectResult }
  | { k: 'tick' };

export type EffectResult =
  | { ok: true; workspace?: unknown; sessionRef?: SessionRef; review?: unknown; head?: string }
  | { ok: false; why: string; transient: boolean };

export type Effect =
  | { k: 'provision'; worker: WorkerId; spec: WorkspaceSpec }
  | { k: 'open_session'; worker: Who; gen: number; turn: TurnInput; resume?: SessionRef }
  | { k: 'send'; worker: Who; gen: number; turn: TurnInput; mode: 'turn' | 'steer' }
  | { k: 'answer_approval'; worker: Who; gen: number; approvalId: string; allow: boolean }
  | { k: 'interrupt' | 'park' | 'kill'; worker: Who; gen: number }
  | { k: 'checkpoint'; worker: WorkerId; message: string }            // office-made commit in the worktree
  | { k: 'review'; worker: WorkerId; taskKey: TaskKey }               // branch/diffstat/mergeable -> task.result
  | { k: 'retire_workspace'; worker: WorkerId }
  | { k: 'reap'; worker: Who; pid: number }                           // orphan from a previous server run
  | { k: 'arm'; key: string; ms: number }
  | { k: 'persist'; urgent: boolean };

export const effectKey = (e: Effect): string => { throw new Error('not implemented'); }; // e.g. `open_session:w-3:gen4`, `checkpoint:w-3:<turnId>`

export type Reply = { ok: true; data?: unknown } | { ok: false; error: string };

export interface StepCtx {
  now: number;
  inflight: ReadonlySet<string>;
  caps: Readonly<Record<AgentKind, Capabilities & { found: boolean }>>;
  /** names already used this mission (kept in state in the real thing), injected for determinism */
  pickName(role: string, taken: ReadonlySet<string>): string;
}
export interface StepResult { state: MissionState; events: OfficeEvent[]; effects: Effect[]; reply: Reply }

export function step(state: MissionState, input: Input, ctx: StepCtx): StepResult {
  throw new Error('not implemented');
  // apply(): per input kind (each branch is a small pure function, all return a new state; a rejected input returns the SAME state + reply.ok=false)
  //
  //  lead_plan
  //    validate at the boundary (dag.validatePlan): key charset/uniqueness, deps exist or are in this call, no cycle (Kahn), size caps,
  //    agent installed (ctx.caps), role/access sane, `pin` points at a non-retired worker. All-or-nothing. Re-sending an identical spec for an
  //    existing key is a no-op (idempotent retry after a lost tool result); a different spec for a not-yet-started key amends it; for a started key -> error.
  //    New tasks: state 'waiting' (converge promotes). Events: one {k:'task'} per node + {k:'plan'} board refresh.
  //
  //  user_said / lead_message to a worker (the single messaging path):
  //    worker.phase 'blocked'/question and (replyTo === that question OR no replyTo)  -> answer it: question.answered, inbox += answer, phase->working (via a turn)
  //    worker.phase 'working'                                               -> inbox += message; delivered at next turn start (or steer if caps.steer)
  //    worker.phase 'idle'|'stopped'|'failed'                               -> new Task{origin:'followup', pin:worker} in 'ready'; message becomes its brief
  //    worker.phase 'retired'                                               -> reject with Korean reason in reply
  //    to === 'chef'                                                        -> chef.inbox += message (wakes Max; also what a plain composer line does today)
  //    A second answer to an already answered question is demoted to a 'note' and the reply says who answered first.
  //
  //  signal (gen must match worker.gen, else drop):
  //    session        -> worker.session = ref (persist urgent: this is what makes resume possible)
  //    approval       -> phase working->blocked{approval}; emit ask{kind:'approval'}
  //    turn_end       -> see turnEnd() below
  //    exit           -> if expected: residency parked; else treat as failed turn (attempts++), keep stderrTail in note (Korean summary, never raw)
  //    think/typing/say/plan/act/act_done/usage -> forward as the same-named OfficeEvent with who, update lastSignalAt (no state change)
  //
  //  turnEnd(worker, outcome, handback):
  //    worker role (not chef):
  //       handback.status 'done' (or none, the safe default) -> task done, result.summary = handback.summary ?? lastText; effects checkpoint -> review
  //       'question'  -> create Question(audience = handback.audience ?? 'lead'), worker->blocked{question}, task stays running, news for lead if audience lead,
  //                      emit ask{kind:'question'} if audience user
  //       'blocked'   -> same as question with text = why
  //       outcome 'error' -> task failed after startFailureLimit consecutive failures, else task ready again (retry on same worker/session)
  //       outcome 'interrupted' (user stop) -> task ready, mission stopped
  //       always: emit report{who,text=summary}, worker->idle (or blocked), news line for lead
  //       if worker.inbox is non-empty -> create followup Task (so every turn belongs to a task)
  //    chef:
  //       phase->idle; every still-open Question(audience 'lead') -> audience 'user' (auto-escalation) + ask event;
  //       if quiescent(state) -> mission end (below)
  //
  // converge(): derive effects, in this order, each guarded by ctx.inflight
  //   0. boot: workers with proc -> reap; phase working|starting|provisioning -> phase 'idle'/note 'interrupted', task running -> ready (note '서버가 다시 켜져서 멈췄어요'),
  //            status working -> stopped. Never auto-resume (matches today); user_resume / any user message flips status back to working.
  //   1. promote: waiting -> ready when all deps done; waiting|ready -> blocked when a dep failed/cancelled (+ news)
  //   2. assign (only when status==='working'): for each ready task in key order: pinned worker idle/stopped/failed -> assign; else if live < maxLive && workers < maxWorkers -> new Worker
  //      (phase provisioning if access 'write' in a repo target, else starting). Over capacity -> stays ready (UI shows 대기).
  //   3. provision -> open_session (first turn = briefFor(task, upstream results)) ; idle worker with assigned task -> send/open_session(resume)
  //   4. approvals answered by the user are already effects (answer_approval); stop -> interrupt then kill after grace (arm timer)
  //   5. lead wake: chef idle|parked, and (inbox non-empty OR news non-empty and now - newsSince >= debounce) -> drain news into one 'news' message, send/open_session
  //   6. park: workers idle for > parkAfterMs and residency live -> park (never while blocked: a parked blocked worker could not receive its answer in-process)
  //   7. quiescent(state) && status 'working' -> status done|error, emit end{ok, stay:true}, effect persist urgent, retire nothing (workers stay seated)
  //   8. any state change -> effect persist (urgent when a durable intent changed: workspace planned, session ref, task state)
}

/** No running/starting/provisioning worker, no ready task that could still start, chef idle, no inbox/news, no open lead-audience question. Pure; unit-tested table. */
export function quiescent(s: MissionState): boolean { throw new Error('not implemented'); }

/** First-turn text for a task: brief + results of finished upstream tasks (summaries inline, branches by name) + workspace rules + handback instructions. Pure. */
export function briefFor(s: MissionState, key: TaskKey): string { throw new Error('not implemented'); }
