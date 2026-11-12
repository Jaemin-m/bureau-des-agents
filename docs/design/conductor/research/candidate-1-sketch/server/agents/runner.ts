// Sketch: server/agents/runner.ts (NEW). One Runner per conversation (Max or a worker), for its whole life.
//
// The Runner is the deep module under the supervisor: callers say "deliver this text" and never learn whether the
// process was alive, busy, parked, or had to be resumed. It owns:
//   - process lifecycle: launch, park after idle, relaunch with resume, fresh relaunch with recap if resume fails;
//   - turn gating: a mailbox; one turn at a time; queued inputs are delivered at the next turn boundary;
//   - launch retry budget (3 consecutive launch failures ⇒ give up), mid-turn crash budget (1 auto-resume);
//   - env hygiene: strips API keys unless BUREAU_USE_API_KEY=1 (C12), adds BUREAU_DES_AGENTS=1;
//   - recording: BUREAU_RECORD=<dir> tees raw stdin/stdout lines with timings into a cassette (fake-CLI fixtures).
// It does NOT know tasks, DAGs, OfficeEvents, or other workers.

import type { AgentKind } from '../../shared/protocol.additions.ts';
import type { Driver, LaunchSpec, ResumeToken, Signal } from './driver.ts';

/** A unit of input. `ref` is the msg id (or 'task' / 'resume' / 'digest') recorded on the worker event when it starts. */
export interface Turn { ref: string; text: string }

/** What the Runner tells its owner. Signals pass through untouched; lifecycle notes are the Runner's own. */
export type RunnerNote =
  | { n: 'signal'; sig: Signal }
  /** a queued Turn just became the running turn */
  | { n: 'turn_started'; refs: string[] }
  | { n: 'launch_failed'; attempt: number; message: string; final: boolean }
  /** process died mid-turn; `resuming` = the Runner is spending its one auto-resume */
  | { n: 'crashed'; message: string; resuming: boolean }
  /** resume token was rejected; relaunched fresh with a recap (context lost — Korean note for the log) */
  | { n: 'context_lost' }
  /** resume token changed (first ready, or fresh relaunch) — owner persists it to the ledger before anything else */
  | { n: 'resume_token'; token: ResumeToken };

export interface RunnerSpec {
  kind: AgentKind;
  /** LaunchSpec minus resume/mcp, which the Runner fills per launch */
  launch: Omit<LaunchSpec, 'resume' | 'mcp'>;
  /** token from a previous server life (ledger) */
  resume?: ResumeToken;
  /** mint a fresh MCP token for each launch; revoke on exit */
  mcp: { url: string; mint(): string; revoke(token: string): void };
  /** recap used when resume fails (last report, task brief) */
  recap(): string;
  /** idle ms before the process is parked (closed, resumable). Max: 15 min (today's IDLE_STOP_MS); workers: 2 min. */
  parkAfterMs: number;
}

export class Runner {
  constructor(driver: Driver, bin: string, spec: RunnerSpec, notify: (note: RunnerNote) => void) {
    throw new Error('not implemented');
  }

  /**
   * Queue a turn. Idempotent by ref: a ref already queued or already started is ignored.
   * TODO
   *   if (seen(ref)) return
   *   mailbox.push(turn)
   *   if (!proc) launch(resume)            // parked or never started
   *   else if (!turnRunning && ready) pump()
   * pump(): turn = mailbox.shift(); wire.prompt(turn.text); notify turn_started(refs)
   * Multiple queued turns are coalesced into one prompt (texts joined with a separator, refs all reported), so a
   * burst of follow-ups costs one turn, not N.
   */
  deliver(turn: Turn): void { throw new Error('not implemented'); }

  answer(approvalId: string, allow: boolean): boolean { throw new Error('not implemented'); }

  /** Interrupt the running turn and drop the mailbox. The process stays (resumable). */
  stop(): void { throw new Error('not implemented'); }

  /** Close for good (mission close / server shutdown). `kill` = no grace period. */
  dispose(kill?: boolean): void { throw new Error('not implemented'); }

  get busy(): boolean { throw new Error('not implemented'); }
  get alive(): boolean { throw new Error('not implemented'); }
  get pid(): number | undefined { throw new Error('not implemented'); }

  // TODO onExit(code):
  //   revoke mcp token
  //   if (disposing) return
  //   if (!readyThisLaunch)          → launchFailures++; notify launch_failed{final: launchFailures>=3};
  //                                     if !final relaunch after backoff 1s,4s (same resume token)
  //   else if (turnRunning)          → crashes++; notify crashed{resuming: crashes<=1};
  //                                     if resuming: mailbox.unshift({ref:'resume', text: RESUME_TEXT}); launch(resume)
  //   else                           → parked silently (idle exit or park timer)
  // TODO on Signal resume_failed: notify context_lost; resume = undefined; mailbox.unshift({ref:'resume', text: recap()}); relaunch fresh
  // TODO on Signal ready: launchFailures = 0; if token changed → notify resume_token; pump()
  // TODO on Signal turn_end: turnRunning = false; crashes = 0; arm park timer if mailbox empty; else pump()
}
