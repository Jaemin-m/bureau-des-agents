// server/conductor/shell.ts (SKETCH): the imperative shell. Thin: owns IO, delegates every decision to step().
// Public surface of the whole conductor package is this file. Bureau, index.ts and lead-mcp.ts import only from here.
import type { OfficeEvent, MissionInfo } from './shared.protocol.ts';
import type { AgentAdapter, AdapterProbe } from './agents.adapter.ts';
import type { Workspaces } from './workspaces.ts';
import type { Input, Reply } from './conductor.step.ts';
import type { MissionState, Who } from './conductor.model.ts';
import type { LeadCommands } from './lead-mcp.ts';

export interface Deps {
  missionId: string;
  dir: string;                                              // <BUREAU_DIR>
  adapters(kind: string): AgentAdapter;
  probes(): Record<string, AdapterProbe>;
  workspaces: Workspaces;
  /** Bureau's journal: stamps `at`, broadcasts {t:'ev'}, appends JSONL, skips `typing`. Conductor never touches the log file. */
  emit(ev: OfficeEvent): void;
  now(): number;
  timer(ms: number, fn: () => void): () => void;           // injected so tests drive time
  pool: { liveCount(): number; reserve(missionId: string): boolean; release(missionId: string): void }; // Bureau-owned, shared across missions later
  settings(): { autonomy: 'ask' | 'auto'; chefModel: string; teamModel: string; useApiKeys: boolean };
}

export class Conductor {
  /** Load <id>.state.json (or create), reconcile workspaces and orphan pids, feed {k:'boot'}, run effects. Resolves when converged, not when work is done. */
  static async open(deps: Deps, init: { mission: MissionInfo; repoPath?: string }): Promise<Conductor> { throw new Error('not implemented'); }

  /** The one way in. Browser messages, lead tool calls and adapter signals are all Inputs; there is no second code path. */
  input(i: Input): Reply { throw new Error('not implemented'); }

  /** Commands Max's MCP calls (lead-mcp.ts). Each wraps `input`. */
  lead(): LeadCommands { throw new Error('not implemented'); }

  /** Token for the lead process currently held, if any. Revoked on exit/park. */
  leadToken(): string | null { throw new Error('not implemented'); }

  /** Read-only view for hello/replay helpers (no live handles). */
  view(): Readonly<MissionState> { throw new Error('not implemented'); }

  /** `new` button / shutdown: stop everything, checkpoint every worktree, retire workers (branches kept), persist synchronously. Idempotent. */
  close(opts: { sync: boolean }): Promise<void> { throw new Error('not implemented'); }

  // private run(effects): for each effect not in inflight: add key -> execute -> input({k:'effect_done'}) -> remove key.
  //   provision -> deps.workspaces.provision ; open_session/send/... -> Session map<Who,{session,gen}> ; checkpoint/review -> workspaces ; reap -> process.kill after `ps -o command=` match
  //   persist -> atomic write (tmp + rename), debounced 200 ms unless urgent
  // private onSignal(who, gen) => sink given to adapters: coalesces `typing` per worker at 250 ms, then input({k:'signal', who, gen, sig}).
}
