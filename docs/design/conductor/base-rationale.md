# Candidate 2: the Conductor (pure state machine, level-triggered converge, adapters behind one session interface)

## Problem

The office today is one Claude Code process per mission; "teammates" are in-process subagents whose identity, lifecycle, reports and
completion are all inferred from one process's stdout (`parent_tool_use_id`, `Agent` tool_use ids, `result`). Every client command
implicitly targets that process. The upgrade makes the server itself own independent worker processes (claude, codex, gemini), a task
DAG, per-worker git worktrees, and per-worker messaging, without Orca or Herdr.

Constraints from grounding that shape the design (names as in `grounding.md` section 6):
- C1/C2/C4/C6: `Logged[]` and the demo must keep replaying; the only UI contract is `OfficeEvent`; unknown kinds are already no-ops.
  Additive only, `who` stays `'chef'` for Max, French identifiers stay.
- Gotchas 1, 5, 6, 7, 8: worker identity must be minted by the server; `end` is mission-global and destructive; a Max turn end no longer means
  the work is done (workers outlive Max's turns); `ask_done` and `say` have no recipient; `say` is logged as `start`.
- C3/C11/C13: only claude exposes stdin multi-turn + host approvals; codex exec and gemini `-p` read stdin once and cannot ask the host;
  workers' sandboxes (codex, gemini) cannot write a worktree's gitdir, and claude `--restricted` raises approvals for git writes;
  never run `* mcp add` (it mutates user config).
- C20/C21: 16 role desks, `Role` is a closed union with sprites and name pools, so the CLI kind must be an orthogonal attribute.
- C28/C26: Node type stripping (no enums), tiny dependency budget, 24 fps / 1 ms frame budget.
- Nothing about codex exec fields, claude mid-turn stdin, MCP-over-HTTP in claude, or gemini headless auth was exercised against a model.
  The design therefore puts every unverified fact behind a recorded fixture (unit U0), not behind code.

## Usage (caller's view)

There are four callers. Each is a few lines, and the types in `sketch/` were derived from them.

**1. The user (browser, wire protocol).** All additive; today's shapes unchanged.

```ts
send({ t: 'start', prompt: '로그인 버그를 고치고 문서도 정리해 줘', target: { repo: '~/code/shop' } }); // target omitted = mission folder, as today
send({ t: 'say', text: '테스트도 추가해 주세요', to: 'w-3-k2f9' });   // to omitted = Max (today)
send({ t: 'reply', requestId: 'q-7', text: 'A안으로 해 주세요' });    // answers a worker's question; {t:'answer'} stays for tool approvals
send({ t: 'stop', who: 'w-3-k2f9' });                                 // one worker; omitted = everything (today)
```

**2. Max (the lead), through four MCP tools the office exposes only to him.** He plans, ends his turn, and is woken with a digest.

```jsonc
// tools/call office_plan   (idempotent per key; all-or-nothing; the key IS the task id)
{ "tasks": [
  { "key": "research", "title": "경쟁사 조사", "brief": "…", "role": "recherche", "agent": "gemini", "access": "read" },
  { "key": "fix-login", "title": "로그인 버그 수정", "brief": "…", "role": "code", "agent": "codex", "access": "write" },
  { "key": "docs", "title": "문서 정리", "brief": "…", "role": "redaction", "agent": "claude", "access": "write", "after": ["research", "fix-login"] } ] }
// -> { "ok": true }   Max then ends his turn. Later he is woken:  "[사무실 소식] 에이다(w-3)가 fix-login을 마쳤어요 … 열린 질문 q-7: …"
// tools/call office_message { "to": "w-3-k2f9", "text": "테스트도 추가해 줘" }   // answer a question OR follow-up work to a running/finished worker
// tools/call office_cancel / office_status
```

**3. The server integration (Bureau and index.ts), the whole surface of the conductor package.**

```ts
const c = await Conductor.open(deps, { mission, repoPath });   // load state.json, reap orphans, reconcile worktrees, converge
c.input({ k: 'user_said', to: 'chef', text });                  // browser msgs, MCP tool calls and adapter signals are ALL Inputs
const mcp = mountLeadMcp({ tokens, port, commandsFor: (id) => conductors.get(id)?.lead() ?? null, installed });
await c.close({ sync: true });                                  // 'new' button / shutdown: checkpoint worktrees, keep branches
```

**4. An adapter author and a test author.**

```ts
const s = adapterFor('codex').open({ cwd, readDirs: [], role: 'code', access: 'write', autonomy: 'ask', systemPrompt }, { text: brief }, sink);
s.send({ text: '테스트도 추가해 줘' }, 'turn');       // process-per-turn or live session: the Conductor cannot tell, by contract
// no-subscription test: a fake `codex` that replays tests/fixtures/codex-0.167.1/*.jsonl, selected with CODEX_BIN
await runScenario({ name: 'dag-with-question', target: { kind: 'repo', fixture: 'two-commit-repo' }, scripts, steps, expect });
```

## Shape

### Core idea

One deep module, `Conductor`, per mission. It is a **functional core with an imperative shell**:

```
step(state, input, ctx) -> { state, events: OfficeEvent[], effects: Effect[], reply }     // pure, in conductor/step.ts
  1. apply(input)      what happened or was asked (user said, Max planned, a worker signalled, an effect finished)
  2. converge(state)   derive what must be done now from state alone (level-triggered, like a controller loop)
```

Every input source (browser, Max's MCP calls, adapter signals, timers, boot) enters through `Conductor.input`. There is one way to change
state, so there is nowhere for rules to diverge. Effects (spawn, send, checkpoint, git, persist) are keyed and idempotent; the shell tracks
`inflight` keys so converge never double-fires. Because effects are derived from state rather than from a transition history, **crash
recovery is "load state.json, feed `boot`, run what converge says"**; there is no journal replay and no recovery-specific code path.

### Data model (all in `sketch/conductor.model.ts`; owner = Conductor, single writer on the event loop, so no locks)

- **Task** = a DAG node. `key` (chosen by Max, `[a-z0-9-]`, unique) is the identity. `after: TaskKey[]`, `role`, `agent`, `access: 'write'|'read'`,
  `state: waiting | ready | running | blocked | done | failed | cancelled`. Monotone: a finished task never reopens. `blocked` = a dependency
  failed or was cancelled; it is surfaced to Max and resolved by cancel, re-plan or retry (`failed -> ready`). Follow-up work is a **new task**
  (`origin: 'followup'`, `pin: workerId`), so dependents of the original are unaffected and every turn belongs to exactly one task.
  A restart does not need a "paused" state: interrupted tasks go back to `ready` with a note, and the scheduler only runs while the mission is `working`.
- **Worker** = a long-lived seat, not a per-task process. Keeps session ref, workspace, inbox. `phase` is a discriminated union so that
  `working` always carries a turn and `blocked` always says on what (`approval` mid-turn, or `question` after a turn ended). Legal moves are one table,
  `NEXT_PHASE`; `moveTo` throws otherwise. `provisioning -> starting -> working <-> blocked -> idle <-> working`, plus `stopping/stopped/failed/retired`.
  Process residency (`live | parked`) is **orthogonal** to phase: a parked idle worker keeps its session ref and is resumed on the next message.
  Max is the same record with `id: 'chef'`, no workspace and no task, so session/park/resume/queue logic exists once.
- **Message** (`user|chef|worker|office -> chef|worker`, kinds `brief|followup|answer|note|news`) and **Question** (a worker ends its turn with a question;
  `audience: 'lead'` first, auto-escalated to `'user'` when Max's next turn ends with it unanswered; first answer wins, later ones become notes).
  Approvals stay what they are today (mid-turn `can_use_tool`); the two are different event kinds (`ask.kind`), because one blocks a live turn and the other
  ends it (explore-clis non-obvious 10).
- **Workspace** = `folder` (mission folder, shared, as today) | `readonly` (repo root, read-only) | `worktree` (own branch). Immutable for a worker's life
  (`SessionRef` carries its cwd, which is what gemini resume and codex resume need).
- **MissionState** holds `tasks`, `workers`, `questions`, `news`, `limits`, a monotone `seq` (ids never repeat across restarts). It is keyed by
  `missionId`, so parallel missions later are "a map of Conductors sharing the Bureau's `Pool`"; nothing hangs off `Bureau.current` (C30).

Access patterns traced: ready set and dependents are O(tasks) scans over a hard cap of 60 tasks per mission (no index to add later); lookup of
worker/task/question is by key; the lead digest is a drained list. Nothing relies on a map we would "add later".

### Who owns what (single owner per piece of state)

| State | Owner | Home |
|---|---|---|
| tasks, workers, questions, queued messages, news | `Conductor` reducer | `.bureau/missions/<id>.state.json`, private, never broadcast, atomic write |
| user-visible history | Bureau journal (append-only) | `.bureau/missions/<id>.jsonl` (`Logged[]`, as today) |
| live processes/sessions | Conductor shell session map | memory; `pid+startedAt` copy in `worker.proc` only for orphan reaping |
| worktree and branch existence | git is the truth; `Workspaces` the only writer | git; intent record in `WorkspaceRef` |
| mission list, settings | Bureau | `.bureau/state.json` |
| view state | client store, a pure fold of the log | none |

The log and the state file are not two copies of one thing: the log is history for humans and replay, the state file is control state
(session ids, paths, queues) that must not reach the browser (C24). Events are *projected* from state transitions inside `step`, never
written by two modules.

### How Max coordinates: an MCP server hosted by the office, four tools

Chosen over structured text output and an office-side planner (see Alternatives). Max is always claude (the only CLI with a long-lived stdin session
and a verified one-shot MCP flag, `--mcp-config ... --strict-mcp-config`). Tools: `office_plan`, `office_message`, `office_cancel`, `office_status`.
- **Non-blocking by design.** Max plans, ends his turn, and the office wakes him (a user-role message with a digest, debounced 1.5 s, batched, at-least-once with ids)
  when something he must act on happens: a worker finished, a lead-audience question, a failure, quiescence. This is Orca's coordinator loop, and it fixes
  gotcha 6: mission completion is no longer "Max's `result`" but `quiescent(state)` (no running worker, no startable ready task, Max idle, no inbox/news,
  no open lead question), after which the Conductor emits `end{stay:true}`. Max cannot forget to finish or finish early, so there is no `office_finish`.
- **Idempotent and validated at the boundary.** `office_plan` is all-or-nothing (cycle check, unknown deps, caps, installed agent), re-sending an identical
  spec is a no-op (lost tool result), amending a not-yet-started key is allowed, amending a started key errors. Errors are Korean sentences Max can act on.
- **The board stays Max-agnostic.** The Conductor derives the legacy `plan` event from the DAG, so the board and old clients work unchanged; Max loses `TodoWrite`
  and `Agent` (two ways to do one task is a red flag; the in-process subagent path is deleted in unit U7).
- **Transport** is Streamable HTTP with JSON responses on the existing server (`POST /lead/<token>/mcp`): tool calls land in-process, no IPC, no extra process to
  supervise. Token = 128-bit per lead process, revoked on exit/park; Host must be loopback; any `Origin` header is rejected (browsers always send one); no CORS;
  256 KB cap. This adds one localhost surface (C8) guarded by a capability token. If claude's `type:"http"` config misbehaves, a 40-line stdio shim proxies to the
  same handler (probe in U0).
- Workers get **no** MCP and no office tools. They hand back with a CLI-agnostic convention (next section), which sidesteps three unverified per-CLI MCP injection
  mechanisms (C13) and works for process-per-turn CLIs.

### Worker to office: the handback block

The last fenced block labelled `handback` in a worker's final message: `{status:'done', summary, files?}`, `{status:'question', question, options?, audience?}`, or
`{status:'blocked', why}`. `parseHandback` (pure, fuzz-tested) is the only place that trusts model prose; it is tolerant: no block, bad JSON or unknown status means
`done` with the whole message as summary, the safe default (the user or Max can still reply to a "done" worker; a follow-up and an answer are the same operation).
The block is stripped from displayed text. When a CLI later offers host tools (codex dynamicTools, gemini ACP `mcpServers`), a `handback` tool can replace the block;
the stable interface is `WorkerSignal.turn_end`, so nothing above the adapter changes.

### The adapter boundary (`sketch/agents.adapter.ts`, `agents.mappings.ts`)

Public surface: `AgentAdapter { probe(), open(spec, firstTurn, sink) }` and `AgentSession { send, answerApproval, interrupt, park, kill }`, plus the neutral
`WorkerSignal` union (session, think, typing, say, plan, act, act_done, approval, usage, turn_end, exit, diag) and `Capabilities { approvals, steer, liveSession, web, hostTools }`.
No stream-json, JSONL, or JSON-RPC type crosses it. `AgentSession` is the *logical* session: `send` works whether or not a process is held, so the Conductor never
orchestrates processes, only turns, and the Conductor never sends while a turn runs (queueing has one owner). A conformance suite (one `turn_end` per turn even on crash,
kill gives a single `exit`, interrupt gives `interrupted`, garbage lines give `diag`) runs against every adapter. Argv builders and mappers are pure functions tested on fixtures.

| | claude (workers and lead) | codex v1 | gemini v1 |
|---|---|---|---|
| mode | `-p` stream-json in/out, long-lived, `--session-id` pre-assigned, `--restricted --tools <role tools by access>` | `codex exec --json -C <cwd> -s <read-only\|workspace-write> -` (prompt on stdin) | `gemini -p <text> -o stream-json --skip-trust --approval-mode <plan\|auto_edit\|yolo> --session-id <uuid>` |
| turn end | `result` | `turn.completed` / `turn.failed` | `result` (exit 53 = turn limit) |
| approvals | `control_request can_use_tool` -> `approval` signal -> `blocked(approval)` | none: sandbox is the policy (UI says so) | none: approval mode fixed at launch; `yolo` only with `-s` |
| follow-up / resume | stdin `user` message; `--resume` after park | new process `exec resume <thread_id>` (never `--last`) | new process `-r <uuid>` in the same cwd |
| steer mid-turn | caps false in v1 (unverified), queue | false | false |
| stop | `interrupt` control_request, then stdin end, SIGTERM after 5 s | SIGTERM | SIGTERM (may yield no `result`: mapper synthesizes `turn_end`) |
| MCP | lead only, `--mcp-config` inline JSON + `--strict-mcp-config` | none | none |
| system prompt | `--append-system-prompt` | prepended to first turn | `GEMINI_SYSTEM_MD` temp file we create |

Policy per CLI maps from two office-level words, `access` (read|write) and `autonomy` (ask|auto); adapters without an approval channel map `ask` to the most
conservative sandbox and report that in `AdapterProbe.note`, which the picker and worker card show. `childEnv` strips API keys per CLI unless `BUREAU_USE_API_KEY=1` (C12).
v1 deliberately uses the process-per-turn family for codex and gemini: fewer unverified facts, stable flags, no schema generation per version. Codex app-server and gemini ACP
(approvals, steer) come later as new adapters behind the same interface and flip `caps`.

### Workspaces and worktrees (`sketch/workspaces.ts`)

`Workspaces` is the only module that runs git. Callers say what the worker needs (`{worker, task, access, upstream}`); it owns names, paths, idempotency and safety.
- **Layout.** Repo missions: every `write` task gets branch `office/<missionSlug>/<taskKey>` in `<worktreeRoot>/<missionSlug>/<taskKey>` (default `<BUREAU_DIR>/.bureau/worktrees`,
  outside the repo so nothing pollutes it and `tidy()` already scrubs it). `read` tasks run with cwd = repo root in a read-only mode. Folder missions are unchanged (shared folder).
- **Start point.** `baseSha` pinned at mission start. A task with code upstream starts from that branch head; several upstreams are merged into the *new* worktree, and a conflict
  aborts and leaves the worktree clean, returning `blocked: upstream conflict` for Max/user. Non-code upstream results travel as summaries inlined into the brief by `briefFor`.
- **The office commits, not the worker.** `checkpoint` = `git add -A && git commit --no-verify` (gpgsign off, repo identity else an office identity) when dirty and HEAD is still our branch.
  Reason: codex and gemini sandboxes cannot write the worktree's gitdir and claude `--restricted` raises approvals on git writes, so worker-owned commits would be a per-CLI special case.
  Workers are told not to run git writes. If HEAD moved off our branch, nothing is committed and the work is left exactly as is (`branchMoved`).
- **Idempotent create.** `provision` is keyed by (mission, task): registered worktree with our branch is adopted; branch without worktree is re-attached (never reset); unregistered
  directory at our path is renamed to `*.orphan-<ts>` (quarantined, never deleted); then `worktree add -b`; then post-checks (`show-toplevel`, HEAD branch). Run it twice or crash between any
  two steps and the result is the same.
- **Never lose user work.** The user's checkout is never touched by the office, except the explicit guarded merge. `retire` = checkpoint, then `worktree remove` without `--force`; if git
  refuses the folder is kept (`retained`). **Branches are always kept** (results come back as branches); deleting one is a separate user action that uses `-d`, and `-D` only if the user
  confirms the exact tip sha, which is also written to `.bureau/trash.json`. `merge-tree --write-tree` gives a conflict badge without touching anything. The "합치기" button (U13) runs
  `merge --no-ff` only if the main checkout is on the base branch, clean, and merge-tree is clean; otherwise it is disabled with a Korean reason.
- **Path safety.** No path segment, branch name or git argument comes from a model or the browser (all derived from minted ids and `[a-z0-9-]` slugs). The user-supplied repo path goes through
  `checkRepo` (realpath, root equals `show-toplevel`, not `/`, not `$HOME`, not inside `.bureau`, not bare, not mid-rebase). All reads/previews use `resolveInside(roots, p)`:
  resolve, `realpath`, `relative` must not escape; it replaces the lexical `startsWith` check (C10) and has an explicit root set (mission folder, live worktrees, reports dir).
- **File events.** Worktrees use `git status --porcelain=v1 -z` polling (bounded, `.gitignore`-aware, no recursive `fs.watch` on a repo with `node_modules`) and `by` becomes exact because a worktree
  has one worker. Folder missions keep `fs.watch` plus today's heuristic.

### Protocol additions and replay (`sketch/shared.protocol.ts`)

- New `OfficeEvent` kinds, all idempotent upserts: `worker{id,phase,block?,taskKey?,parked?}`, `task{key,title,after,state,worker?,agent?,result?}` (full node each time), `msg{id,from,to,kind,text,replyTo?}`.
  Optional fields: `hire.agent`, `hire.taskKey`, `ask.kind/options`, `end.stay`, `MissionInfo.target`. `say` gains `to`, `start` gains `target`. New ClientMsgs: `reply`, `retire`, `resume`, `repo_check`, `merge`, `discard_branch`.
  `hello` gains `agents: AgentInfo[]` (`claude` stays for old tabs).
- **Old logs replay unchanged** because nothing existing is removed or re-meant and every handler stays a no-op for unknown kinds. A legacy `hire` has no `agent`, so the store reads `agent ?? 'claude'`, `phase = working`, and a legacy
  `leave` removes the robot as before. New logs also emit `hire`, `report`, `plan`, `file`, `act` with unchanged shapes, so even a pre-upgrade client shows a legible office.
  `report` may now repeat per worker (store already overwrites; world resets `reported` on `worker{working}`); `end{stay:true}` skips "everyone walks out" and keeps open asks.
- Fixes the client gaps in grounding: `hire` dedup by id (gotcha 3), `ask_done` decrements the asker via `askOwner` (7), AskBar shows a stack, user messages to a worker are `msg`, never `start` (8).
- `hello` restore stays a single fold of the log. To avoid orphaned `hire`s past the 8000 cap (9), the server sends `compactLog(log)`, a pure function with a property test
  (fold of compact equals fold of full on roster, tasks, asks, plan, end). No second "snapshot" source of truth.
- Demo and tests: `scripts/make-demo.ts` is untouched; the scenario harness emits valid `Logged[]`, so a multi-worker demo is one more fixture (`public/demo/multi.json`) produced with zero quota.
- Scrubbing (C24): events carry branch names and counts, never absolute paths; worktrees live under the office dir (already covered by `tidy`), the repo is shown by `target.label`.

### Crash and restart convergence

- State file is written atomically (tmp + rename), debounced 200 ms, **immediately** whenever a durable intent changes (workspace `planned`, session ref learned, task state). Session ids are pre-assigned where the CLI allows (claude, gemini) so the ref exists before the process does.
- Boot (`boot.ts`): load state; for every worker with a recorded `pid`, check it is alive and `ps -o command=` matches before `SIGTERM` (orphans from a killed server would otherwise keep editing a worktree that we are about to resume). On shutdown all children are killed (codex/gemini do not exit on parent death).
  `Workspaces.reconcile` adopts registered worktrees, quarantines unregistered dirs, prunes vanished metadata. Any worker that was `working|starting|provisioning` becomes `idle` with a note, after an office checkpoint commits its dirty tree (a clearly labelled "중단된 작업 보관" commit); its task goes back to `ready`;
  the mission becomes `stopped`. No auto-resume (same as today's `working -> stopped`); `{t:'resume'}` or any user message flips it to `working` and converge reopens sessions with `resume`.
- Idempotency everywhere: effects are keyed (`open_session:w-3:gen4`), stale signals are dropped by `gen`, `office_plan` is idempotent per key, answers are first-wins, wake digests are at-least-once with ids, `checkpoint` is a no-op on a clean tree.
  Circuit breaker: three consecutive start failures on a task fail it (Orca rule); silence is never treated as death (only a `quiet` badge after 5 minutes; the user decides to stop).

### Visualization within existing limits (`sketch/client.fold.ts`)

Role keeps meaning desk/sprite/name; `agent` is a badge. Draw code only, no images, no frame-budget change.
- Agent chip (C / X / G, three colours) drawn after the sprite with the existing pixel font; phase badges: working = today's typing, blocked = raised hand with `?` (question) or `!` (approval), idle = check, parked = zZ, failed = cross, provisioning = dots.
- Seats: role desk, then any free desk, then lounge (the sofa, `SPOTS.lounge`, 3 spots), then overflow, then a "+N" stack. Idle workers yield desks first (`reclaimSeat`), so 16 desks + 3 + 8 spots absorb a 12-worker cap with only ever-few workers actually working (`maxLive` default 4, so the room never needs more than a handful animated at once).
- Board (96x35 px) shows up to four lines topologically with a depth indent and a "대기 3 · 완료 5" line; the Panel gets the full DAG list. Worker card (Rooms): agent and vendor ("Codex가 해요"), thread, branch, diff stat, mergeable badge, 합치기. Copy that promised "real Claude Code subagents" now names the real CLI (C25) and says which vendor sees upstream summaries.
- Load: adapters throttle `typing` at 120 ms; the shell coalesces per worker at 250 ms; `typing` is never logged (C7); `worker`/`task` events are state changes only.

### No-subscription test harness (`sketch/harness.ts`)

Fake CLIs are real child processes (`tests/fake-cli/bin/{claude,codex,gemini}`, found via `CLAUDE_BIN`/`CODEX_BIN`/`GEMINI_BIN`) that replay **recorded real wire streams** with steps:
`emit` (raw line), `wait`, `expectInput`, `writeFile` (edits the worktree so checkpoints and branches are real), `approval`, `handback`, `exit | crash | hang`, and `mcp` (the fake *lead* makes a real HTTP `tools/call`
to the office, so Max to workers to wake to `end` runs end to end). Real adapters, real git on temp repos, no model. Fixtures come from `scripts/record-cli.ts`, run once by a human (unit U0, a few cents), committed per CLI version; that run also answers
the open questions (codex exec fields, claude mid-turn stdin, `type:"http"` MCP, gemini headless auth). Time is injected (`deps.now/timer`). Layers: pure table tests (dag, step, `NEXT_PHASE` matrix, `parseHandback` fuzz, `compactLog` property), temp-repo tests (workspaces, roots escapes), adapter conformance suite, scenarios, and kill/restart scenarios (`SIGKILL` the server, assert orphan reaped, work checkpointed, tasks `ready`, main checkout sha unchanged).
`npm test` is `node --test`, no new dependency. Scenario output `Logged[]` also replays in the browser via `__bureau.playReplay`.

### Interface depth, stated explicitly

- `Conductor`: 6 public members (`open`, `input`, `lead`, `leadToken`, `view`, `close`) hide the state machine, scheduling, queues, wake batching, persistence, recovery, effect idempotency and per-worker session bookkeeping.
- `AgentAdapter/AgentSession`: 2 + 5 methods hide process lifecycle, wire formats, resume semantics, sandbox/approval mapping, parse diagnostics, and per-CLI quirks. Exposed to callers: `Capabilities` only, because it changes what they may ask.
- `Workspaces`: callers state need, not git steps. Exposed: the `WorkspaceRef` (opaque to everything but `files.ts`) and `Review`.
- `lead-mcp`: four tools whose schema, validator and handler come from one table (no hand-synced lists).
- Red-flag screen: no pass-through layers (Bureau does not forward to Conductor except for registry/broadcast, `lead-mcp` adds validation and auth); no importable internals (per-CLI adapters importable only from `registry.ts`, enforced by a grep in `npm run check`); no split ownership (table above);
  one way per task (subagent path deleted, `TodoWrite` removed from Max, one messaging path for answer/follow-up/steer); `TaskState`/`WorkerPhase` defined once in `shared/protocol.ts`, `NEXT_PHASE` is the single transition table; the capability table in Max's prompt is generated from probes, not typed.

## Synthesis decision

*(to be filled in by arena)*

## Tradeoffs accepted

- We accept one OS process per claude worker (heavier than an in-process subagent, counts against subscription concurrency, `maxLive` default 4) in exchange for isolation, per-worker resume/stop/messaging and mixed CLIs.
- We accept that workers hand back via a text convention rather than a tool call, in exchange for CLI-agnostic behaviour that needs no per-CLI MCP injection; absence degrades safely to `done`.
- We accept that codex and gemini workers cannot raise approvals or be steered mid-turn in v1 (UI says so), in exchange for stable, simple process-per-turn adapters; session adapters flip `caps` later.
- We accept that Max must be claude in v1 (`hostTools` is a capability, so this is a flag, not a rewrite).
- We accept that the office makes commits on workers' branches (`--no-verify`, gpgsign off) in exchange for a uniform, sandbox-proof checkpoint and no git approvals; user hooks do not run on scratch branches.
- We accept a private state file next to the public log (control state vs history) in exchange for keeping paths and session ids out of the browser and out of `Logged[]`.
- We accept a hard cap (60 tasks, 12 workers) in exchange for O(n) scans with no indexes.
- We accept no auto-resume after a server restart (matches today) in exchange for never surprising the user with agents editing files after a reboot.
- We accept an extra localhost HTTP surface (the lead MCP endpoint) guarded by a per-process capability token, Host and Origin checks, in exchange for in-process tool calls.
- We accept that `end` can fire while workers remain seated (`stay:true`), a semantic extension that looks odd next to the legacy "everyone leaves", because long-lived workers are the point.
- We accept generating the legacy `plan` event from the DAG and dropping `TodoWrite` for Max; Max's private to-do habits are lost, the board is now truthful.

## Alternatives considered

1. **Office-side planner (one LLM call returns a JSON DAG, no persistent lead).** Hides less than it seems: the planner prompt, parsing, replanning on failure and "follow-up from the user" all re-enter as special cases, and Max's judgment mid-flight (reassign, escalate, summarize) is lost. Interface to callers is smaller but the behaviour is rigid. Rejected.
2. **Structured output from Max (fenced JSON commands in his text).** Avoids the HTTP surface, but there is no tool-result feedback inside the turn (validation errors arrive a turn late), no schema enforcement by the CLI, and it duplicates the handback parser with a second trust boundary for the most important commands. Kept only as the theoretical fallback if both HTTP and stdio MCP fail in U0.
3. **PTY/TUI multiplexing like Herdr and Orca (drive the interactive CLIs and scrape state).** Gives all CLIs one transport but no structured events, no approvals, no reliable turn end: every UI state would be inferred from screen text. Contradicts the "office drives them itself" decision. Rejected.
4. **Event-sourced domain ledger (journal inputs, rebuild state by replay, project events).** Perfect audit and trivially deterministic, but two logs to keep consistent (domain ledger and `Logged[]`), replay must stub effects, and input volume (every delta) forces compaction rules. Snapshot plus level-triggered converge gives the same crash story with one file and no replay. Rejected.
5. **Worker per task (Orca "dispatch") instead of long-lived workers.** Simpler lifecycle, but a follow-up to a finished worker would lose its context and worktree, which is the headline feature ("send follow-up work to a finished worker"). Rejected; the follow-up-is-a-new-task rule keeps the DAG monotone anyway.
6. **Session adapters first (codex app-server, gemini ACP) so every CLI has approvals and steer.** Better UX ceiling, but experimental, version-dependent schemas and several unverified facts (loadSession, mcpServers, auth) on the critical path. Deferred behind the same interface, which is the point of the boundary.
7. **Workers commit their own work.** Needs per-CLI git-write permission handling and fails inside codex/gemini sandboxes. Rejected for office checkpoints.
8. **Keep in-process subagents alongside external workers.** Two ways to do one task, doubling prompts, event sources and tests. Rejected; one path, the old Normalizer subagent code is deleted in U7 (old logs need no parser, they are already `OfficeEvent`s).

## Open questions and risks

1. Does claude accept `--mcp-config` with `type:"http"` under `--restricted --strict-mcp-config`, and does `--allowedTools mcp__office__*` suppress approvals? (U0 probe; fallback is the stdio shim.) Can it be verified with a zero-model `tools/list`, or does it need one tiny paid call?
2. Are the codex exec JSONL field names, the gemini `-p` behaviour on SIGTERM and headless OAuth, and claude's handling of a mid-turn stdin message what the mappers assume? (U0 recordings decide; until then mappers are written to fixtures, not guesses.)
3. Where should worktrees live? `<BUREAU_DIR>/.bureau/worktrees` defaults into `~/Documents`, which may be iCloud-synced; installing dependencies there is slow and noisy. Should the default be a cache dir, and should it be user-configurable per repo?
4. A fresh worktree has no `node_modules`. Should a repo target carry an optional, user-approved setup command (e.g. `npm ci`) run after provision, or do workers handle it themselves?
5. Data disclosure: upstream summaries from a claude task are inlined into a gemini or codex worker's brief, so a different vendor sees them. Is a per-mission "allowed agents" setting enough, or does each handoff across vendors need a visible cue and a confirmation?
6. Is the guarded "합치기" button wanted for non-developers, or should v1 stop at branch name, diff stat and conflict badge, leaving merging to the user's own tools?
7. Subscription contention: several headless claude/codex/gemini processes share rate limits and auth refresh. Is `maxLive = 4` a sane default, and should the Conductor back off on a rate-limit signal (claude `rate_limit_event`, codex `account/rateLimits/updated`, none for gemini)?
8. Max's context cost grows with wakes. Should wakes carry only summaries plus ids and make `office_status` the way to pull detail (current plan), or should big reports be passed by file path?
9. Preview of generated sites for worktree workers (`/apercu/` is per mission folder today): defer, or add per-worker preview roots now?
10. Is process-per-turn for claude workers worth offering as a lower-memory mode, given parked claude sessions already resume with `--resume`?

## Next implementation step

Add the additive protocol types and `conductor/model.ts` + `dag.ts` + `step.ts` with table tests (no IO), while a human runs `scripts/record-cli.ts` once to capture codex/gemini/claude fixtures and answer open questions 1 and 2.

## Delivery sequence

Each unit is small, keeps `npm run check && npm run build` green, and keeps `public/demo/mission.json` replaying identically (checked by folding the demo and diffing the resulting store state against a golden captured before U1).

| Unit | What | Check that ends it |
|---|---|---|
| U0 | `scripts/record-cli.ts`: one paid run that records real streams (claude stream-json incl. an approval and an interrupt; codex exec first turn and `resume`; gemini `-p` first turn and `-r`) and probes MCP-over-HTTP in claude, mid-turn stdin, gemini headless auth. Commits `tests/fixtures/<cli>-<version>/`. | Fixture files exist; a one-page probe report answers open questions 1 and 2; nothing else in the repo spends quota. |
| U1 | Protocol additions (`worker`, `task`, `msg`, optional fields, new ClientMsgs, `compactLog`) and the client fold (store: `tasks`, `phase`, `agent`, thread, ask stack, hire dedup, `end.stay`; world untouched except multi-report/askOwner). No server change. | Old demo folds to the identical golden state; a hand-written `Logged[]` with new kinds plays via `__bureau.playReplay` without errors; `compactLog` property test; check and build green. |
| U2 | Adapter boundary and claude adapter extraction: `agents/{adapter,registry,lines,env,claude}.ts`; `Bureau` consumes `WorkerSignal`s but keeps today's single-process flow (lead-only path, subagent normalizer parked in `agents/claude.ts` until U7). | Recorded claude stream through the new adapter yields the same `Logged[]` as the old Normalizer (golden diff ignoring timestamps); a manual 1-minute mission still works. |
| U3 | Fake-CLI harness and `npm test`: `fake-agent.ts`, wrappers, script steps, adapter conformance suite for claude. | `npm test` green offline in under 10 s; conformance passes for the claude adapter. |
| U4 | Pure core: `conductor/model.ts`, `dag.ts`, `step.ts`, `text.ts` with table tests (plan validation incl. cycles and idempotent resend, ready set, `quiescent`, question audience auto-escalation, circuit breaker, first-answer-wins, `NEXT_PHASE` matrix, `parseHandback` fuzz). | Unit tests green; no module in `conductor/` (except `shell.ts`) imports `node:*`. |
| U5 | `workspaces.ts` and `roots.ts` on temp git repos: provision twice and with a simulated crash between steps, adopt, quarantine, checkpoint on dirty/clean/branch-moved, retire refusal on dirty, `merge-tree` badge, repo intake rejections, symlink and `..` escapes, branch-name injection. | Tests green; asserts main checkout sha and status never change. |
| U6 | `conductor/shell.ts`, `boot.ts`, `lead-mcp.ts`, `files.ts` for **folder missions with claude workers**; fake lead script calls `office_plan` over real HTTP; wake, `end{stay}`, persistence. | Scenario "two claude workers, one depends on the other" produces the expected event subsequence and `done` tasks; kill-and-restart scenario converges (tasks `ready`, mission `stopped`, no orphan pid). |
| U7 | Cut-over: `Bureau` runs on `Conductor`; delete `--agents`, subagent Normalizer paths, `server/claude.ts`, Max's `Agent`/`TodoWrite`; new lead prompt; fix UI copy (C25) and Korean strings. | All scenarios and demo replay green; one real small mission with the real claude as smoke (paid, optional but recommended). |
| U8 | Messaging: `say.to`, `reply`, worker thread in the card, recipient chip, ask stack, auto-escalation, first-answer-wins; `stop/retire` per worker. | Scenario: worker asks, Max leaves it, it escalates, user replies, worker continues; second answer becomes a note; UI checked by replaying the scenario log in the browser. |
| U9 | Repo targets: `repo_check`, repo picker, worktree per write task, office checkpoints, upstream branch composition, git-status file events, `task.result` branch/diff in the card. | Scenario with fake workers writing files: branches exist with commits, main checkout sha and status unchanged, conflict case yields `blocked`, restart adopts worktrees. |
| U10 | `codex-exec` adapter from fixtures, `hello.agents` probes, agent picker and badge, vendor disclosure copy. | Adapter conformance and fixture tests green; scenario with fake codex; one tiny real codex task as smoke. |
| U11 | `gemini-print` adapter, same checks (including resume in the same cwd and SIGTERM without `result`). | Conformance and fixture tests green; scenario with fake gemini; tiny real smoke. |
| U12 | World visuals: agent chip, phase badges, seat reclaim to lounge, DAG board lines, camera shots. | Frame time with 12 robots under 1 ms in the dev console; `__CAPTURE` stills of the multi-worker demo reviewed; `public/demo/multi.json` produced from a scenario replays. |
| U13 | Merge and cleanup: mergeable badge, guarded `mergeIntoBase`, `discardBranch` with sha confirmation and trash record. | Git tests on temp repos (clean merge, conflict refused, dirty checkout refused, unmerged `-D` needs sha). |
| U14 (later) | Session adapters: codex app-server, gemini ACP (approvals, steer), flipping `caps`; parallel missions (map of Conductors over a shared `Pool`). | Same conformance suite passes with `approvals:true`; two-mission scenario. |
