# Candidate 1: the log is the office's memory, the office runs the DAG, Max only declares it

## Problem

Today a mission is one `claude -p` process. Teammates are in-process subagents whose identity, lifecycle, reports and
permission ownership are all inferred from that one process's stdout (`parent_tool_use_id`, `Agent` tool ids, `result`).
The upgrade makes the server supervise independent worker processes of three different CLIs, in a shared mission folder
or in per-worker git worktrees, ordered by a task DAG, each addressable for questions and follow-ups. The shape is not
obvious for four reasons. (1) The CLIs differ in kind, not degree: only claude multiplexes turns over stdin; codex and
gemini need JSON-RPC modes (`app-server`, `--acp`) to get approvals at all (grounding 6.3). (2) Someone must own the
DAG, and the lead is an LLM that ends turns and forgets. (3) `OfficeEvent` logs are the replay contract (C1–C7): old
`hire/leave` from `toolu_…` ids and the 189-event demo must fold unchanged, and `end` is destructive in the client.
(4) Repos bring a new failure class: losing user work, path escapes, leftover worktrees after a crash (C10, C15–C18, C31).

## Usage (caller's view)

**대표님 (browser).** Start mode gains a toggle "폴더 / 코드 저장소" and a path field. Everything else is the same
composer, now with a recipient chip:

```ts
send({ t: 'start', prompt: '로그인 폼을 만들고 테스트도 붙여 줘', repo: '/Users/me/work/shop' });
send({ t: 'say', text: '비밀번호는 8자 이상이면 돼요', to: 'w-build-1', replyTo: 'q-k3f9' }); // answer a question
send({ t: 'say', text: '버튼 색만 파란색으로 바꿔 줘', to: 'w-build-1' });                    // follow-up after done
send({ t: 'stop', who: 'w-test-1' });                                                          // stop one worker
send({ t: 'branch', missionId, branch: 'bureau/m1a2b/build', action: 'merge' });               // 합치기
```

**Max (lead, claude) — office MCP tools.** Max declares; the office executes. One plan call, then end the turn:

```jsonc
// mcp__office__plan
{ "tasks": [
  { "key": "research", "title": "경쟁사 로그인 UX 조사", "role": "recherche", "brief": "…", "agent": "gemini" },
  { "key": "build", "title": "로그인 폼", "role": "code", "agent": "codex", "after": ["research"], "brief": "…" },
  { "key": "test",  "title": "폼 테스트", "role": "code", "agent": "claude", "after": ["research"], "brief": "…" },
  { "key": "review", "title": "합쳐서 검토", "role": "code", "after": ["build", "test"], "brief": "…" } ] }
// → "계획을 받았어요. 지금 시작: research. 대기: build, test, review. 소식이 생기면 깨울게요. 턴을 끝내세요."
```

Later Max is woken by a digest ("[사무실 소식] 에이다(build): 질문이 있어요 (q-k3f9): 비밀번호 규칙은요?") and answers
with `message({to: '에이다', replyTo: 'q-k3f9', text})` or escalates with `ask_user`. At the end: `finish({summary})`,
which the office refuses while any task is still running or ready.

**Worker (any CLI) — two office tools.** `ask({question, to: 'lead'|'user'})` then end the turn; `done({summary})` then
end the turn. A worker that ignores the tools still works: a clean turn end is an implicit `done` with its last message.

**Server code.** `index.ts` stays a dispatcher; one object per mission hides everything else:

```ts
const run = await MissionRun.create(deps, mission, prompt);   // or MissionRun.restore(deps, mission) after a restart
run.say(text, to, replyTo); run.answer(requestId, allow); run.stop(who); await run.branchAction(branch, 'merge');
// POST /mcp → officeMcp.handle(headers, body) → run.tool(caller, name, args)
```

Inside, a worker is one line of intent: `runner.deliver({ ref: msg.id, text })`. Whether the process was alive, busy,
parked, or must be resumed (or recreated fresh with a recap) is the Runner's problem. Adding a CLI = one file
implementing `Driver` (`probe`, `launch → Wire{prompt, approve, interrupt, end}` + `Signal`s); `Record<AgentKind, Driver>`
makes forgetting to register it a type error.

## Shape

**Data first: every fact has one home and one writer.**

| State | Home | Sole writer | Readers |
|---|---|---|---|
| Tasks (DAG nodes), worker states, messages, open asks, reports, branch results | mission JSONL log (`OfficeEvent`), folded by `shared/mission.ts` | `MissionRun.record()` | server (decisions), browser (drawing), replay, restore |
| Task status (`blocked/ready/running/done/failed/cancelled`) | nowhere: derived by `taskStatus(view, key)` | — | board, scheduler, UI |
| Resume tokens, absolute cwd/worktree paths, pids | `.bureau/missions/<id>.ledger.json` | `MissionRun` (put before spawn) | `restore()` only |
| Process, mailbox, retry counters, MCP token | memory, `Runner` / `OfficeMcp` | Runner / OfficeMcp | — |
| Mission card (title, folder, status, workspace, stats, files) | `state.json` (`MissionInfo`) | Bureau via MissionRun callbacks | hello, history |
| Worktrees and branches | git | `server/git/worktrees.ts` | — |

The load-bearing decision is the first row: **orchestration state is a pure fold over the event log, and the same fold
runs in the server and the browser** (`foldMission`, per separate-before-serializing-shared-state and "derive, don't
sync"). The supervisor never mutates state; it records events and reads the fold. Consequences fall out instead of being
built: late tabs, replays, the demo and post-crash restore cannot disagree with the live server; a delivery is
idempotent because `worker{turns:[msgId]}` is in the log (`undelivered()` is a query, not a queue); Max's wake digest is
derivable after a crash, so the lead's inbox cursor need not be persisted.

**Worker lifecycle** (`shared/protocol.additions.ts`, transitions only in `orchestra/worker.ts` `step()`):
`starting → working → idle | waiting | stopped | failed | interrupted`, re-entering `working` on any delivered turn,
and `gone` only on release (mission end/close). Process liveness (alive vs parked) is deliberately *not* a state: a
parked idle worker and a live idle worker are the same thing to the user and to Max. `leave` is emitted only on release,
so the world's exit animation keeps its old meaning; finished workers sit in the lounge, not out the door.

**DAG.** Max owns the *intent* (task specs via `plan`), the office owns *execution*. `validatePlan` is all-or-nothing
and idempotent (cycle check, unknown deps, no edits to started tasks, unknown/missing CLI falls back to claude with a
note). `schedule(view)` is pure: launch ready tasks in plan order up to `maxWorkers` (default 4), wake Max when a report,
question-to-lead or failure arrives and he is idle, finish when nothing is running, ready, or open. A task whose upstream
failed stays `blocked` and wakes Max; nothing is silently skipped.

**Workspace.** One rule per mission kind, not per task. Folder mission: every worker's cwd is the mission folder (today's
behaviour, fs.watch attribution via `act.path`). Repo mission: every worker gets `<office>/.bureau/worktrees/<mission>/
<worker>` on branch `bureau/<mission>/<task>`; Max gets a detached read lens at base. A downstream task starts from
its upstream branches, merged by plumbing without touching any work tree (`merge-tree --write-tree` + `commit-tree`,
C17); a conflict fails the task to Max with the branch names. Workers never commit (claude `--restricted` would ask for
git writes, codex's sandbox blocks the shared `.git`): the office commits leftovers to the worker's own branch at `done`
and at release, then removes the clean worktree. Results are branches; "합치기" merges into the user's checkout only if
it is on base, clean, and conflict-free; "버리기" moves the ref under `refs/bureau/archive/…`. No `--force`, no `-D`,
realpath containment before any removal (`worktrees.ts` R1–R5).

**Coordination channel: the office is an MCP server** at `POST /mcp` on the existing 127.0.0.1 server (Streamable HTTP
subset, JSON responses, ~150 lines, no dependency). It is the only host-tool channel all three CLIs accept per run
without touching user config (C13). Bearer tokens are minted per Runner launch and *are* the caller identity; requests
with an `Origin` header are refused so web pages cannot reach it. Tool sets are per caller kind: lead {plan, message,
ask_user, finish, board}, worker {ask, done}. Every tool returns immediately (Orca's rule: ask, then end the turn), so
no CLI tool timeout or blocked turn is ever in play. Questions therefore have one channel for every CLI, separate from
tool-permission `ask`/`ask_done`, which stays the native approval round trip.

**Adapter boundary** (`server/agents/`). `Driver.launch(spec) → Wire` + `Signal`s; nothing above it sees stream-json or
JSON-RPC, and nothing below it sees tasks or `who`. The Runner adds the policy every CLI needs identically: mailbox and
turn gating (follow-ups wait for the turn boundary; bursts coalesce into one turn), park after idle (Max 15 min, workers
2 min), resume with the stored token, fresh relaunch with a recap when resume fails, 3 launch failures ⇒ failed, one
auto-resume after a mid-turn crash, API-key stripping for all three vendors, cassette recording.

| | claude | codex | gemini |
|---|---|---|---|
| Mode | `-p` stream-json, long-lived | `app-server --listen stdio://`, one per worker | `--acp`, one per worker |
| Instructions | `--append-system-prompt` | `thread/start.developerInstructions` | prepended to first prompt (no system field; `GEMINI_SYSTEM_MD` would replace) |
| Office MCP | `--mcp-config <0600 file> --strict-mcp-config`, `--allowedTools mcp__office__*` | `thread/start.config.mcp_servers.office` (url + bearer env) | `session/new.mcpServers` (http, else stdio shim) |
| Powers | `--restricted --tools claudeTools(powers)` | sandbox `read-only`/`workspace-write`(+network if web) | out-of-powers tool ⇒ auto-deny at approval |
| Approvals | `can_use_tool` ↔ `control_response` | `*/requestApproval` ↔ `{decision}` | `session/request_permission` ↔ `outcome` |
| Follow-up | stdin `user` at turn boundary | `turn/start` | `session/prompt` |
| Resume | `--session-id` fresh, `--resume` later | `thread/resume` | `session/load` if advertised, else recap |
| Stop | `interrupt` control_request → stdin end | `turn/interrupt` → close | `session/cancel` → close |

Max stops using the `Agent` tool and `--agents`; in-process subagents disappear as a runtime path (one way to staff a
task), while their old logs still fold.

**Protocol and replay.** Additive only: events `task`, `worker`, `msg`, `branch`; optional `hire.agent/taskKey`,
`file.branch`, `MissionInfo.workspace`; `say.to/replyTo`, `stop.who`, `start.repo`, `branch`/`diff`. No new
mission-mutating `ServerMsg` (everything travels inside `ev`), so replay guards are unchanged (C6). User→worker messages
are `msg`, never `start` (gotcha 8). The fold treats `hire` of a known id as re-entry (gotcha 3) and `ask_done` by
requestId (gotcha 7). `trimLog` drops only chatty events from the 8000-event hello log (gotcha 9). The old demo is a test
fixture: the new store must fold it to a snapshot equal to today's.

**Crash/restart.** Ledger entries are written *before* spawn or worktree creation, so restart always knows what to reap
or adopt. `restore()`: refold the full JSONL; kill orphan pids whose command line matches the recorded bin; mark
live-turn workers `interrupted`; reconcile `git worktree list` with the ledger (prune missing, adopt unknown as orphans,
never delete). Nothing relaunches until the user continues; then interrupted workers get a resume turn and undelivered
messages are redelivered by id. Every step is idempotent.

**Stage.** Role keeps deciding sprite, zone and name pool (C21). CLI kind is a 2×2 px antenna light (claude orange, codex
white, gemini blue; none for legacy subagents). One `seatFor(role, state)`: working → own-zone desk → any free desk →
overflow; idle/stopped/failed → lounge (6 new spots by sofa and coffee bar) → offstage via the door while staying in the
roster. With ≤ 8 working at once, 16 desks suffice. `?` bubble for open questions, `!` stays for approvals, a flag for
a ready branch. The chalkboard draws `boardItems` (DAG when present, else old `plan`); the DAG itself is an HTML list
by layers in the board room. Per-robot cost stays one cached-sprite blit plus overlays (C26).

**Interface depth.** The public surface is small: browser `say/stop/answer/branch/diff/start`, MissionRun's handful of
methods, two tool sets, one `Driver` interface. Hidden behind it: process lifecycle and resume across three wire
protocols, turn gating, scheduling and the completion rule, worktree creation/integration/cleanup, crash
reconciliation. Callers never coordinate several calls to finish one operation (red flag "shallow module").

## Synthesis decision

## Tradeoffs accepted

- We accept one OS process per worker (claude ≈ hundreds of MB) in exchange for real isolation, per-worker resume and
  CLI choice; `maxWorkers` (default 4, max 8) and 2-minute parking bound it.
- We accept that follow-ups wait for the turn boundary on every CLI (no claude mid-turn stdin, no codex `turn/steer`) in
  exchange for one predictable rule; the existing "단계 사이에 읽어요" copy already promises this.
- We accept supporting only the JSON-RPC modes for codex and gemini (experimental `app-server`, version-pinned schema)
  in exchange for approvals, follow-ups and resume; `exec --json` and `-p` are dropped, not kept as fallbacks.
- We accept that the office creates commits on its own branches (identity fallback "에이전트 사무실") in exchange for
  never losing worker output and never asking workers for git writes.
- We accept that folder missions still share one folder between parallel workers (no isolation) in exchange for keeping
  today's non-developer experience identical.
- We accept the log growing new event kinds and the server folding it on every record in exchange for one definition of
  state shared by server, browser, replay and restore. This is not over-engineering: it replaces three ledgers (server
  `present`/`names`, store `agents`, world `actors`) with one derivation for orchestration facts.
- We accept that Max loses in-process subagents in exchange for one staffing path; a quick lookup Max used to delegate
  now costs a worker launch.

## Alternatives considered

- **Max as imperative dispatcher** (`start_worker`, `wait_for`, Orca-style, office passive). Smaller office, but the DAG
  lives only in Max's context: readiness, retries and "who is blocked on whom" are re-derived by an LLM every turn and
  lost on context compaction or crash. It exposes scheduling to the caller; ours hides it behind `plan`.
- **Structured-output planner** (`--json-schema` plan once, office executes). Deep and deterministic, but no
  mid-mission judgment: questions, failures and follow-ups would need a second channel anyway, which is the MCP surface.
- **Workers as tools Max calls** (an MCP tool that runs `codex exec` and returns the result). Simplest, but blocks Max
  for the whole job, has no per-worker messaging, no approvals for codex/gemini, and dies with Max's turn.
- **Mutable supervisor state + snapshot file** instead of the event fold. Familiar, but creates a second source of truth
  beside the log that the browser already folds; every new field would need sync code in two places and restore would
  trust a snapshot that can be older than the log.
- **CLI-provided worktrees** (`claude -w`, `codex --worktree`, `gemini -w`). Three placement and cleanup policies, one
  of them behind an experimental settings flag; the office could not guarantee R1–R5.

## Open questions and risks

- Do codex `thread/start.config` keys for an HTTP MCP server with a bearer env var (`mcp_servers.office.url`,
  `bearer_token_env_var`) work at 0.167.1, and does `workspace-write` allow web search when asked? (one paid probe)
- Does gemini `--acp` pass subscription/OAuth auth non-interactively, advertise `loadSession`, and accept HTTP MCP? If
  OAuth fails headless, should gemini be disabled with a Korean `problem`, or allowed only with `GEMINI_API_KEY` opt-in?
- Should the office auto-commit at all, or leave dirty worktrees for the user to inspect? (we chose commit-on-branch.)
- Is "합치기" into the user's checkout wanted in v1, or should results stay branches with a copyable command?
- Three CLIs running in parallel under one subscription each: token refresh contention and rate limits are unmeasured;
  is `maxWorkers=4` right, and should limits be per CLI?
- Merge conflicts between upstream branches fail the downstream task to Max; is a dedicated "resolve conflict" task
  (worker in an integration worktree) needed in v1?
- Risk: the lead may loop (wake → plan nothing → end turn). The completion rule finishes the mission when Max is idle
  and nothing is open, but a pathological Max could still ping-pong digests; cap wakes per minute?
- Risk: codex `app-server` schema drift. Mitigation is probe-time method checks and cassettes per version; is pinning a
  supported version range acceptable to the user?

## Next implementation step

Record golden logs from today's code with a `BUREAU_RECORD` tee in `ClaudeProcess`, then extract `agents/driver.ts` +
`agents/claude.ts` + `agents/runner.ts` so Max alone runs through the Runner and replays that cassette byte-for-byte.

## Delivery sequence

Each unit ends in a check that needs no subscription spend unless marked.

1. **Harness first.** `node --test` + `npm test`; `scripts/fake-cli.ts` (claude only) and the `BUREAU_RECORD` tee in
   today's `ClaudeProcess`; record two cassettes from existing missions' shapes. *Check:* fake-claude replays a cassette
   against unchanged code and the produced `Logged[]` equals a golden file.
2. **Driver boundary, no behaviour change.** `agents/driver.ts`, `runner.ts`, `claude.ts`, `probeAgents`. Max keeps
   `--agents` for now; subagent hire/report/leave ride a temporary `{s:'legacy', ev}` Signal that unit 5 deletes. *Check:* unit-1 goldens still match; `npm run check`;
   demo replays.
3. **Shared fold + protocol types.** `shared/mission.ts`, additive protocol, store uses `foldMission`, hire re-entry,
   `ask_done` by requestId, `trimLog`. *Check:* demo-fold snapshot equals today's store fields; unit tests for fold.
4. **Office MCP + lead tools on an empty board.** `/mcp`, tokens, `plan`/`board`/`finish`, Max launched with
   `--mcp-config`. *Check:* scenario where fake-claude calls `plan` produces `task` events; Origin/no-token requests get
   401; a token from one mission cannot call another's run.
5. **Workers in folder missions (claude only).** `board.ts`, `worker.ts`, `MissionRun` launching claude workers, worker
   tools `ask`/`done`, digest wakes, completion rule; Max drops `Agent`/`--agents`. *Check:* `folder-research-write`
   and `ask-reply` scenarios match goldens; `step`/`schedule` table tests pass.
6. **Stage for many workers.** `seatFor`, lounge spots, kind light, `?`/flag icons, AskBar list, recipient chip, agent
   room thread/composer, board DAG list, honest copy, tidy patterns. *Check:* replay unit-5 scenario logs in the browser
   via `window.__bureau.playReplay`; 8 working robots hold ≤ ~1 ms/frame and 24/8 fps caps; old demo looks unchanged.
7. **Follow-ups and re-entry.** say{to} after `end`, gone→working re-entry, stop{who}. *Check:* `followup-after-end`
   scenario.
8. **Repo missions.** `worktrees.ts` (validateRepo, ensureWorktree, startPointFor, saveWork, releaseWorktree,
   archiveBranch, mergeIntoCheckout), lens, git-status file scan, `branch`/`diff` messages, branch card. *Check:* git tests
   in temp repos (idempotent create, dirty release kept + committed, archive recoverable, symlink escape rejected,
   merge refused on dirty checkout) and `repo-two-branches` scenario.
9. **Codex driver.** `rpc.ts`, `codex.ts`, probe method checks. *Check:* hand-written codex cassette (from the generated
   schema) passes the build/test scenario with codex workers; then **one paid probe** (user-approved) records a real
   cassette and replaces the hand-written one.
10. **Gemini driver.** `gemini.ts`, stdio MCP shim fallback. *Check:* same as 9 with an ACP cassette, then one paid probe.
11. **Crash convergence.** Ledger-before-spawn ordering, `restore()` reconcile, orphan reaper. *Check:* `crash-restore`
    scenario restarts the server mid-mission; no duplicate deliveries, worktrees intact, orphans reported not deleted.
12. **Docs and demo.** README "Pour Claude Code" section, CLAUDE.md module list, `make-demo.ts` scrubbing repo/worktree
    paths; optionally ship one scenario log as a second demo. *Check:* `npm run check`, `npm run build`, `npm test`,
    old demo and one new scenario replay in a clean browser profile.
