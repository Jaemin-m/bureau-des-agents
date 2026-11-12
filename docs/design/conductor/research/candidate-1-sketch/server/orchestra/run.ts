// Sketch: server/orchestra/run.ts (NEW). MissionRun = the supervisor of ONE mission.
//
// Ownership:
//   - writes the mission log (and therefore MissionView, via foldMission) — the only writer;
//   - owns the Runners (Max = who 'chef', workers = 'w-<task>-<n>') and the per-mission ledger;
//   - executes board.ts decisions and worker.ts transitions; calls worktrees.ts for repo missions;
//   - answers office MCP tool calls for its callers (mcp.ts resolves token → (run, who)).
// Bureau keeps: mission registry, settings, file read/versions/preview, replay, team history. It holds
// `runs: Map<missionId, MissionRun>` and today enforces "one working at a time" in start() (C30: nothing here assumes one).

import type { FileInfo, Logged, MissionInfo, OfficeEvent, ServerMsg, Settings } from '../../shared/protocol.ts';
import type { AgentKind, OfficeEventAdditions } from '../../shared/protocol.additions.ts';
import type { MissionView } from '../../shared/mission.ts';
import type { Installed } from '../agents/rpc-and-index.ts';
import type { Ledger } from './ledger.ts';

type Ev = OfficeEvent | OfficeEventAdditions;

/** Who is calling an office tool. Minted by mcp.ts per Runner launch; never derived from tool arguments. */
export type Caller = { missionId: string; who: 'chef' } | { missionId: string; who: string; worker: true };

export interface ToolResult { text: string; isError?: boolean }

export interface RunDeps {
  /** office dir, ledger dir, worktree root (= <BUREAU_DIR>/.bureau/worktrees) */
  paths: { office: string; records: string; worktrees: string };
  agents: Record<AgentKind, Installed>;
  settings: () => Settings;
  broadcast: (m: ServerMsg) => void;
  /** persist MissionInfo changes (Bureau.save) */
  saveMission: () => void;
  mcp: { url: string; mint(caller: Caller): string; revoke(token: string): void };
}

export class MissionRun {
  readonly mission: MissionInfo;
  /** folded public state; read-only outside this class */
  view: MissionView;
  /** in-memory log for hello, trimmed by trimLog (structural events are never dropped, gotcha 9) */
  log: Logged[];

  private constructor() { throw new Error('not implemented'); }

  /**
   * New mission. For repo workspaces Bureau has already validated the repo (worktrees.validateRepo) and resolved
   * base + baseSha. Creates the mission folder (reports and Max's final summary live there in both kinds),
   * records `start`, launches Max.
   */
  static async create(deps: RunDeps, mission: MissionInfo, prompt: string): Promise<MissionRun> { throw new Error('not implemented'); }

  /**
   * After a server restart (mission was 'working' and is now 'stopped', or user reopens it to continue).
   * TODO reconcile — every step idempotent, safe to run twice:
   *   1. log ← full JSONL; view ← fold(log)
   *   2. ledger ← read; reap orphans: for each ledger pid, if alive and `ps -o command=` matches the recorded bin → SIGTERM
   *   3. for each worker in starting|working|interrupted: record worker{interrupted, note:'사무실이 다시 켜졌어요'}
   *   4. repo missions: worktrees.inventory(repo, root/missionId) vs ledger:
   *        ledger entry, dir missing  → git worktree prune; recreate lazily on next delivery (ensureWorktree)
   *        dir present, no entry      → adopt as orphan: toast '주인 없는 작업 공간이 있어요' (never deleted)
   *   5. nothing is relaunched until the user acts ("이어서 하기" = say to chef, or a message to a worker):
   *        then interrupted workers get Turn{ref:'resume'} and undelivered(view, w) msgs are redelivered by id.
   */
  static async restore(deps: RunDeps, mission: MissionInfo): Promise<MissionRun> { throw new Error('not implemented'); }

  // ── commands from the browser (index.ts handle()) ──

  /**
   * to absent|'chef': record start{text}, deliver to Max (today's behaviour, incl. flipping status to working).
   * to = worker: record msg{followup|answer}, deliver to that worker's Runner (relaunch/resume as needed),
   * flip mission to working if it had ended (worker re-enters the office).
   * replyTo must name an open question addressed to 'user' (else toast '이미 답한 질문이에요').
   */
  say(text: string, to?: string, replyTo?: string): void { throw new Error('not implemented'); }

  /** requestId → view.asks[requestId].who → that Runner.answer(); record ask_done. Unknown id ⇒ no-op. */
  answer(requestId: string, allow: boolean): void { throw new Error('not implemented'); }

  /** who absent: stop every Runner, finish(stopped). who = worker: stop that one; Max hears it in the next digest. */
  stop(who?: string): void { throw new Error('not implemented'); }

  /** repo only. merge: worktrees.mergeIntoCheckout; archive: worktrees.archiveBranch. Records branch{state}. */
  async branchAction(branch: string, action: 'merge' | 'archive'): Promise<void> { throw new Error('not implemented'); }

  async diff(branch: string, file?: string): Promise<{ text: string; truncated: boolean }> { throw new Error('not implemented'); }

  /** "새 미션": finish if working, release all workers (leave), save + release worktrees, dispose Runners. */
  async close(): Promise<void> { throw new Error('not implemented'); }

  /** SIGINT/SIGTERM: kill Runners, flush ledger synchronously. Worktrees untouched (restore() handles them). */
  shutdown(): void { throw new Error('not implemented'); }

  // ── office MCP tools (mcp.ts → here) ──

  /**
   * Lead tools: plan, message, ask_user, finish, board.   Worker tools: ask, done.
   * Every tool returns quickly; nothing blocks waiting for another agent (Orca's ask/reply rule: ask, then end turn).
   * TODO
   *   plan     → board.validatePlan(view, ctx, args) → record events; stop cancelled; runSchedule(); reply text
   *   message  → resolveWorker(to) → record msg{followup | answer(replyTo)} → runner.deliver(Turn{ref: msg.id})
   *   ask_user → record msg{question, from:'chef', to:'user', options}; reply '대표님께 물어봤어요. 턴을 끝내세요.'
   *   finish   → refuse while any task is running|ready (list them); else finish(ok, summary)
   *   board    → digest(view, 0)
   *   ask      → record msg{question, from: worker, to: args.to ?? 'chef'}; mark turn.asked; reply '질문을 보냈어요. 턴을 끝내세요.'
   *   done     → record report{who, text}; mark turn.doneReport; repo: saveWork + summarize → record branch{…}
   */
  async tool(caller: Caller, name: string, args: unknown): Promise<ToolResult> { throw new Error('not implemented'); }

  // ── internals (sketch of the spine; all private) ──

  /** append JSONL + fold + trim + broadcast `ev`; `typing` broadcast only (C7). The ONLY state writer. */
  private record(ev: Ev): void { throw new Error('not implemented'); }

  /**
   * TODO after any readiness-changing record (debounced to one microtask):
   *   for d of board.schedule(view, {maxWorkers}, leadCursor, log.length):
   *     launch    → cwd = folder | await worktrees.ensureWorktree(…startPointFor(upstream branches)…)
   *                   conflict ⇒ record worker{failed, note:'앞선 작업 브랜치끼리 충돌해요'} instead
   *                 ledger.put(worker) BEFORE spawn; record hire{agent, taskKey} + worker{starting}; runner.deliver({ref:'task', text: brief})
   *     wake_lead → chef.deliver({ref:'digest-'+log.length, text: digest(view, leadCursor)}); leadCursor = log.length
   *     finish    → finish(ok, lastChefText)
   */
  private runSchedule(): void { throw new Error('not implemented'); }

  /**
   * Today's finish(), generalised: record end, status, workMs, cancel open asks. Then release workers:
   * each non-gone worker → step(release) → leave; repo: saveWork + releaseWorktree (kept if it cannot be removed safely).
   * Max's Runner parks after 15 min as today; worker Runners park after 2 min.
   */
  private finish(ok: boolean, text: string, stopped: boolean): void { throw new Error('not implemented'); }

  /** repo missions: after act_done of write-ish acts (debounced 1 s) and at turn end, `git status --porcelain` in that
   *  worker's worktree → file{file:{…, branch}, isNew}, by = that worker (exact attribution, no fs.watch on big repos).
   *  folder missions keep today's recursive fs.watch with by = writers.get(abs) from act.path. */
  private scanFiles(workerId: string): Promise<FileInfo[]> { throw new Error('not implemented'); }
}

/** Keep the hello log under MAX_LOG by dropping the oldest chatty events (act, act_done, think, worker-say, non-new file)
 *  and never structural ones (start, init, hire, task, worker, msg, report, leave, ask, ask_done, branch, plan, end, error). */
export function trimLog(log: Logged[], max: number): void { throw new Error('not implemented'); }

export type _Refs = [Ledger];
