# Module map (candidate 1)

Call chain for any live event: `agents/<cli>.ts` (wire → Signal) → `agents/runner.ts` (lifecycle note) →
`orchestra/run.ts` (worker.ts/board.ts decide, `record()` folds + broadcasts). Three files, then the browser.

## shared/ (Node type stripping + Vite)

| File | Status | Owns |
|---|---|---|
| `shared/protocol.ts` | changed, additive | Wire contract. + `AgentKind`, `Workspace`, `WorkerState`, `Party`, events `task`/`worker`/`msg`/`branch`, optional `hire.agent/taskKey`, `file.branch`, `MissionInfo.workspace`, `Settings.agentFor/maxWorkers/repos`, `say.to/replyTo`, `stop.who`, `start.repo`, `branch`/`diff` msgs, `hello.agents`. |
| `shared/mission.ts` | new | `foldMission` (the only definition of orchestration state from events) + selectors `taskStatus`, `openQuestions`, `undelivered`, `layers`, `resolveWorker`. Used by server and client. |
| `shared/activity.ts` | changed | + `AGENT_INFO: Record<AgentKind, {label, light}>`; `ROLE_TOOLS` derived from `ROLE_POWERS` via `claudeTools`; `describeAct` unchanged (claude); codex/gemini act labels produced in their drivers with the same `ActKind`s. |

## server/

| File | Status | Owns |
|---|---|---|
| `server/index.ts` | changed | HTTP/WS as today; + `POST /mcp` → `OfficeMcp.handle`; new `ClientMsg` cases routed to the current `MissionRun`; `probeAgents()` replaces `findClaude()`. |
| `server/bureau.ts` | changed, shrinks | Mission registry (`state.json`), settings, file read/versions/preview (containment via realpath for worktree files), replay, team history. `runs: Map<missionId, MissionRun>`; one working mission enforced in `start`. No process code left. |
| `server/orchestra/run.ts` | new | `MissionRun`: the supervisor of one mission. Sole writer of the log/view, owner of Runners and ledger, executes board/worker decisions, answers MCP tools, worktree orchestration, completion, stop, close, restore/reconcile. |
| `server/orchestra/board.ts` | new, pure | `validatePlan`, `schedule`, `digest`. DAG rules and the completion rule. |
| `server/orchestra/worker.ts` | new, pure | `step`: worker lifecycle transition table → events. |
| `server/orchestra/ledger.ts` | new | Private per-mission runtime facts (resume tokens, abs paths, pids); atomic JSON; written before spawn. |
| `server/orchestra/prompts.ts` | new (replaces `team.ts`) | `ROLE_POWERS`, Max's and workers' instructions. |
| `server/agents/index.ts` | new | Only public door into `agents/`: `probeAgents`, `Runner`, types. |
| `server/agents/driver.ts` | new | `Driver`, `Wire`, `Signal`, `LaunchSpec`, `Powers`, `ResumeToken`. |
| `server/agents/runner.ts` | new | Per-conversation lifecycle: mailbox + turn gating, park/resume/fresh-recap, retry budgets, env hygiene, cassette recording. |
| `server/agents/claude.ts` | moved from `server/claude.ts` | stream-json driver; Normalizer minus subagent inference. |
| `server/agents/codex.ts` | new | `codex app-server` JSON-RPC driver (private wire types pinned to the probed version). |
| `server/agents/gemini.ts` | new | `gemini --acp` JSON-RPC driver. |
| `server/agents/rpc.ts` | new | JSON-RPC 2.0 line peer (private to codex/gemini). |
| `server/mcp.ts` | new | Office MCP endpoint (Streamable HTTP subset), tokens → callers, tool specs per caller kind. |
| `server/mcp-stdio.ts` | new | ~30-line stdio⇄HTTP bridge for CLIs without HTTP MCP. |
| `server/git/worktrees.ts` | new | Every git command the office runs; safety rules R1–R5. |
| `server/claude.ts`, `server/team.ts` | deleted | Moved into `agents/claude.ts` and `orchestra/prompts.ts`. |

## src/ (client)

| File | Status | Owns |
|---|---|---|
| `src/state/store.ts` | changed | `view: MissionView` via `foldMission`; hire re-entry dedupe; worker-state→AgentView mapping; feed lines for `msg`; selectors `boardItems`, `pendingForUser`. |
| `src/engine/world.ts` | changed | `seatFor` (hot-desk, lounge, offstage), worker-state walks, `ask_done` by requestId, kind light + `?`/flag overlays. |
| `src/engine/layout.ts` | changed | `SPOTS.lounge` (6), asserted walkable. |
| `src/engine/robots.ts`, `icons.ts` | changed | Kind light overlay; `?` and flag icons. |
| `src/engine/camera.ts` | changed | Shots for `msg{question}` and `branch{ready}`. |
| `src/ui/Dialog.tsx` | changed | Composer recipient chip + reply; start-mode workspace picker; AskBar list. |
| `src/ui/Rooms.tsx` | changed | Agent room (thread, composer, stop, branch card, CLI line); board room DAG list; honest copy. |
| `src/ui/Panel.tsx` | changed | Team list by `view.workerOrder` with state chips. |
| `src/ui/tidy.ts` | changed | Worktree root and repo roots scrubbed. |

## scripts/ and tests

| File | Status | Owns |
|---|---|---|
| `scripts/fake-cli.ts` | new | Cassette player impersonating all three CLIs, incl. MCP calls and approvals. |
| `scripts/scenario.ts` + `scenarios/*.json` + `scenarios/cassettes/*` | new | Headless end-to-end runs vs golden `Logged[]`; outputs replayable logs. |
| `scripts/check-imports.ts` | new | Fails `npm run check` if anything outside `server/agents/` imports `server/agents/*` except `index.ts`, or anything but `run.ts` imports `git/worktrees.ts`. |
| `test/*.test.ts` | new | `node --test` for pure modules, git safety, demo-fold snapshot. `npm test` added. |
| `scripts/make-demo.ts` | changed | Also scrubs repo roots / worktree root; drops ledger. |
