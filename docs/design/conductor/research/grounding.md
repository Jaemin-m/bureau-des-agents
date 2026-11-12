# 에이전트 사무실: how a mission runs today, and what assumes "one Claude session per mission"

Shared grounding for the multi-CLI / worktree / DAG / per-worker-messaging upgrade. Synthesized from three explorer
reports (`explore-server.md`, `explore-client.md`, `explore-clis.md` in this folder) and re-checked against the code at
`91f32e6` (branch `main`, clean). Line numbers are for that commit. Where explorers disagreed, the code wins and the
correction is noted inline as **[reconciled]**.

---

## 1. Overview

The office is a localhost web app with two halves joined by one WebSocket:

- **Server** (`server/`, run directly by Node >= 22.18 with type stripping). One `Bureau` object owns *the* current
  mission. For that mission it spawns **one** headless Claude Code process (`claude -p`, stream-json in and out) whose
  cwd is the mission folder. That process is "Max" (the lead, `who === 'chef'`). Teammates are **not processes**: they
  are Claude Code subagents that Max launches with the `Agent` tool, defined by a `--agents` JSON passed at spawn.
  A `Normalizer` turns Claude's stream-json lines into `OfficeEvent`s; the Bureau stamps them, broadcasts them to every
  browser tab, and appends them to a per-mission JSONL log.
- **Client** (`src/`, Vite + React + zustand + hand-drawn canvas). The store (`src/state/store.ts`) folds
  `OfficeEvent`s into view state and forwards each event on a bus to the pixel-art world (`src/engine/world.ts`) and the
  camera director (`src/engine/camera.ts`). The client knows nothing about Claude; it only knows `OfficeEvent`.
  Because state is a pure fold over events, the same code path renders live missions, late-joining tabs (log replay),
  saved-mission replays, and the offline demo (`public/demo/mission.json`).

The seam that makes the upgrade feasible: **`OfficeEvent` is the only contract the UI depends on**. The seam that makes
it hard: the server derives worker identity, lifecycle, reports, permission ownership and mission completion entirely
from *one Claude process's* stdout (`parent_tool_use_id`, `Agent` tool_use ids, `task_notification`, `result`), and
every client→server command implicitly targets that one process.

---

## 2. Key Concepts

| Concept | What it is today | Where |
|---|---|---|
| **Mission** | A folder `<BUREAU_DIR>/미션/<YYYY-MM-DD HH시 MM분 · 제목>` + a `MissionInfo` record + a JSONL event log. Not a git repo. | `server/bureau.ts:174-203`, `shared/protocol.ts:20-37` |
| **Current** | The single open mission: `{mission, log, live, names, watcher, fileTimers, idleTimer, busySince, stopAsked, lastChefText}`. `Bureau.current` is one nullable field. | `server/bureau.ts:68-81`, `:110` |
| **Live** | `{proc: ClaudeProcess, norm: Normalizer, stopping, lastText, resumed}` — exactly one process + parser pair per mission. | `server/bureau.ts:59-66` |
| **Session** | Claude's `session_id`, stored as the single `MissionInfo.sessionId`; used for `--resume` after the process idles out or dies. | `protocol.ts:31`, `bureau.ts:230, 260-264` |
| **Chef / Max** | The main Claude session. In the client a separate `chef: ChefView` field (not in `agents`) and a permanent `'chef'` actor in the world. | `store.ts:32-39,70`; `world.ts:124,146` |
| **Teammate / agent** | A Claude subagent invoked by Max's `Agent`/`Task` tool call. Its id **is that tool_use id** (`toolu_…`); every later event about it uses `who = parent_tool_use_id`. | `claude.ts:274, 292, 302-306`; `protocol.ts:39-42` |
| **Role** | `'chef' \| 'recherche' \| 'code' \| 'design' \| 'redaction' \| 'analyse' \| 'renfort'` (7 values: Max, 5 defined trades, and `renfort` as the catch-all for unknown `subagent_type`). Drives tools, desk zone, sprite colour, name pool. **[reconciled]** server report said "5 roles", client said "7": both true. | `protocol.ts:6`; `activity.ts:15-58`; `team.ts:16-42` |
| **OfficeEvent** | `start, init, think, typing, say, plan, hire, act, act_done, report, leave, file, ask, ask_done, end, error`. | `protocol.ts:43-62` |
| **Logged** | `{at, ev}` — the unit of the in-memory log, the JSONL file, `hello.current.log`, `replay.log`, and the demo. | `protocol.ts:65` |
| **ask** | Only a *tool-permission* request (`can_use_tool`) with `requestId`; answered by `answer{requestId, allow: boolean}`. There is no free-form question channel. | `protocol.ts:59-60,104`; `claude.ts:227-236` |
| **plan** | Max's own `TodoWrite` items, display-only; not a server-owned task list, no ids, no deps, no assignees. | `claude.ts:310-316`; `protocol.ts:11,49` |
| **report / leave** | `report` = the subagent's `SubagentHandback` tool call (or its tool_result text as fallback); `leave` = `task_notification` or the Agent tool_result. | `claude.ts:261-271, 307-309, 326-345` |

---

## 3. How It Works

### 3.1 Boot and connection

`server/index.ts:45` runs `findClaude()` (`claude.ts:24-36`: `CLAUDE_BIN`, `PATH`, a few known locations, each verified
with `--version`). If none is found, `claude` is `null`: the server still runs but `start`/`say` throw, and the UI shows
install guidance. `new Bureau(...).init()` (`bureau.ts:126-140`) creates folders, writes `사무실 규칙.md` if missing, loads
`.bureau/state.json`, and **downgrades any mission left `working` to `stopped`** — there is no process recovery across
server restarts. The HTTP server listens on `127.0.0.1:PORT` (`index.ts:24, 187-211`).

A browser connects to `/ws`; `server.on('upgrade')` rejects any path other than `/ws` and any `Origin` not in
`allowedOrigins` (`index.ts:107-118`). Each socket joins a global `clients` set and immediately receives `hello`
(`bureau.ts:163-169`): claude info, office dir, settings, quota, the 60 most recent missions, and
`current: {mission, log} | null`. The store rebuilds the open mission by applying the whole log with `live=false`
(`store.ts:186-195`), so late tabs snap to the right state without animation. If the socket never opens within 2.5 s the
client switches to demo mode and loops `public/demo/mission.json` (`link.ts:22, 42-45, 106-116`). If `hello.build`
differs from the build the tab loaded, the tab reloads (`link.ts:33-37`).

### 3.2 Starting a mission

The Composer (`Dialog.tsx:163-175`) has three modes: `new` (no mission → `{t:'start', prompt}`), `steer` (mission busy →
`{t:'say', text}`, placeholder "단계 사이에 읽어요"), `retouch` (mission ended → `{t:'say'}`). `handle()` (`index.ts:138-185`)
dispatches; strings are length-capped by `str()` and the socket has `maxPayload: 1_000_000`.

`Bureau.start` (`bureau.ts:174-203`) refuses if the current mission is `working`, otherwise `close()`s it, creates the
mission folder, pushes a `MissionInfo` (id `'m' + Date.now().toString(36)`, cap 300 missions), starts a recursive
`fs.watch` on the folder, broadcasts `{t:'mission'}`, then calls `say(prompt)`.

`Bureau.say` (`bureau.ts:206-225`) spawns a process if there is none alive, flips the mission back to `working` if it had
ended, **records `{k:'start', text}` for every user message** (first prompt, steer, and retouch alike —
**[reconciled]** the client explorer's open question), and writes a stream-json `user` message to stdin. There is no
queue or recipient: all text goes to Max's stdin.

### 3.3 Spawning Claude

`Bureau.spawn` (`bureau.ts:227-256`) snapshots settings, the office rules file, and the team JSON **at spawn time**
(settings changes reach the process only on the next spawn). Exact argv (`claude.ts:77-88`):

```
claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
  --permission-prompt-tool stdio --permission-mode <auto|acceptEdits>
  --restricted --tools Agent,TodoWrite,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch,Bash
  --agents '<5 roles: description, prompt, tools=ROLE_TOOLS[role], model=teamModel>'
  --append-system-prompt '<chefPrompt(rules)>'
  [--model <chefModel>] [--resume <sessionId>]
  --allowedTools Agent,TodoWrite,Read,Glob,Grep,WebSearch,WebFetch
  --disallowedTools AskUserQuestion
```

Env (`claude.ts:89-99`): `BUREAU_DES_AGENTS=1`, `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1` (only office roles),
`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` (teammates cannot spawn), `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` (Max waits
for reports), and `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` deleted unless `BUREAU_USE_API_KEY=1` (forces the user's
subscription login). `permission: 'ask'` maps to `acceptEdits`, `'auto'` to `auto` (`bureau.ts:241`).

`--restricted` (verified with `claude --help`, v2.1.322 — **[reconciled]** the server explorer's open question): removes
code-running tools and WebFetch *unless `--tools` names them* (the office names Bash and WebFetch, so they remain),
ignores user/project/local settings files (MCP servers still load unless `--strict-mcp-config`), confines file tools to
the working directories (+ `--add-dir`), refuses `bypassPermissions`, and lets only a person or the permission handler
approve writes to settings, **git**, and tool-config files.

Every stdout callback and the Normalizer's `emit`/`onResult` are guarded by `cur.live?.proc === proc`
(`bureau.ts:233-235, 246`), so late output from a superseded process is dropped. stdout is parsed per line; unparsable
lines are silently skipped (`claude.ts:102-107`); stderr keeps the last 4000 chars (`:108`); exit is reported once on
`close` (`:109-117`).

### 3.4 Normalizing stream-json into OfficeEvents (`Normalizer.handle`, `claude.ts:212-345`)

- `system/init` → `init{model, auth}`; Bureau copies `session_id` into `mission.sessionId` and saves (`bureau.ts:260-264`).
- `stream_event` → `think` on thinking block start; `typing` throttled to 120 ms from `text_delta` (`:273-289`).
  `who = m.parent_tool_use_id ?? 'chef'`.
- `assistant` → for each content block (`:291-324`): text → `say`; `tool_use` named `Agent`/`Task` → **`hire`**
  (`id = tool_use.id`, `role = roleOfType(subagent_type)`, unique name from the role's pool, `task = description`
  cut to 48, `prompt` cut to 2000) and `present.add(id)`; `SubagentHandback` → `report{who, text: input.message}`
  (**[reconciled]** event field is `text`; lines 307-309, not 312-314); `TodoWrite` from chef → `plan`; anything else →
  `act` via `describeAct`, and Write/Edit/MultiEdit record `writers[file_path] = who`.
- `user` tool_results (`:326-345`): if the id is a present teammate → fallback `report` from
  `tool_use_result.handbackReport.text` or content, then `leave{ok, tokens, tools, ms}`; else `act_done`.
- `system/task_notification` → `leave` (`:261-263`). `task_started` fills `agentOfTask`, which nothing reads.
- `result` → `onResult` (end of a turn). `rate_limit_event` → `Quota{fiveHour, resetsAt}` broadcast.
- `control_request{can_use_tool}` → store input under `request_id`, resolve `who` via `whoOfTool[tool_use_id]` (else
  `'chef'`), emit `ask` with Korean `permissionText`. Any other control_request subtype is refused immediately so Claude
  never blocks (`:227-229`, `bureau.ts:247-248`). `control_cancel_request` → `ask_done{cancelled:true}`.

### 3.5 Recording and broadcasting

`Bureau.onEvent` (`bureau.ts:258-269`) updates stats (`countStats`), then `record()` (`:334-341`): broadcast
`{t:'ev', missionId, at, ev}` to **all** clients; `typing` stops there (never logged); everything else goes into the
in-memory log (capped at `MAX_LOG = 8000`) and is appended to `.bureau/missions/<id>.jsonl`. `hire`/`init` trigger a
debounced atomic save of `state.json` (`:528-541`).

### 3.6 Files and versions

`watch()` (`bureau.ts:344-357`) ignores any path segment starting with `.` and `node_modules`, debounces 350 ms per path,
and `fileChanged()` (`:359-375`) emits `file{file, isNew}` with `by = norm.writers.get(abs) ?? previous by ?? 'chef'`
(so files created via Bash are credited to Max). Files ≤ 5 MB get a copy in
`.bureau/versions/<missionId>/<name>/<mtime>__<by>.<ext>`, 30 per file, where `by` is squeezed to `[\w-]`
(`:378-387`).

### 3.7 Permission round trip

`ask` shows in the AskBar (first ask only, "외 N건", `Dialog.tsx:119-129`) and over the robot. The user clicks →
`{t:'answer', requestId, allow}` → `Bureau.answer` (`bureau.ts:451-458`) → `control_response` with
`updatedInput = original input` or a fixed Korean deny message (`claude.ts:131-139`) → `ask_done`. Request ids live in
the *current Normalizer*; there is no timeout. `finish()` cancels any still-pending requests.

### 3.8 Ending, idling, resuming

`onResult` (`bureau.ts:271-276`) **ignores a successful `result` while teammates are still `present`** (Max will resume
when their results come back). Otherwise `finish()` (`:278-304`) synthesizes `leave{ok:false}` for anyone present,
sets status `done|stopped|error`, accumulates `workMs`, cancels pending asks, records `end`, and arms a **15-minute idle
timer** that then `stop()`s the process (stdin end, SIGTERM after 5 s). A later `say` respawns with
`--resume <sessionId>`. If a resumed process dies before `init` (Claude deleted the session), `onExit`
(`:306-332`) clears `sessionId` and respawns fresh, re-sending the last message (context is lost). `stop` sends an
`interrupt` control_request; the resulting `result` finishes the mission as `stopped`. `close()` (`new` button)
force-finishes, stops the process, and broadcasts `closed`. `shutdown()` (SIGINT/SIGTERM) kills immediately and saves
synchronously.

### 3.9 Client fold and stage

`store.apply` (`store.ts:235-352`) updates state per kind and **always** ends with `bus.emit(ev, live)`; neither the store
nor `World.apply` (`world.ts:242-377`) nor `Director.event` (`camera.ts:73-98`) has a `default` case, so unknown kinds
are no-ops. `hire` assigns a role desk (`assignSeat`, `world.ts:222-225`) or an overflow spot; `report` walks the
report to Max's inbox (`deliver`); `leave` walks the robot out and deletes the actor; `end` walks out everyone still
present and celebrates. The world draws into a 352 × 256 canvas; `Office.tsx:79-120` caps drawing at 24 fps when
something moves, 8 fps at rest, and nothing when `document.hidden`.

### 3.10 Replay and demo

`{t:'replay', missionId}` → `Bureau.replay` re-reads the full JSONL (not the 8000-capped memory log) → the client's
`playReplay` (`link.ts:56-86`) sets `replaying=true`, resets the mission, and re-applies each `Logged.ev` **with
`live=true`** (animated), compressing gaps to ≤ 2.5 s. While replaying, `hello`/`mission`/`ev`/`closed` are ignored
(`store.ts:188,199,205,209`). The offline demo is the same path with `loop: true`. **[reconciled]** the client report
said demo replay takes the `live=false` branch; only `hello` restoration does — replay and demo are animated.
`scripts/make-demo.ts` builds the demo from a real mission, scrubbing the mission folder and home dir, and dropping
`sessionId`.

### 3.11 Sequence of one mission today

```mermaid
sequenceDiagram
  autonumber
  participant U as Browser (Composer/store/world)
  participant S as index.ts handle()
  participant B as Bureau (current)
  participant N as Normalizer
  participant C as claude -p (Max + in-process subagents)
  participant D as Disk (.bureau, mission folder)

  U->>S: {t:'start', prompt}
  S->>B: start(prompt)
  B->>D: mkdir 미션/<stamp · title>, fs.watch(recursive)
  B-->>U: {t:'mission'} (status working)
  B->>B: say(prompt) → record {k:'start'}
  B->>C: spawn(cwd=mission folder, --restricted --agents … [--resume sid])
  B->>C: stdin {"type":"user", …prompt}
  C-->>N: system/init (session_id)
  N-->>B: init → mission.sessionId saved
  B-->>U: ev init  (+ append JSONL)
  C-->>N: assistant tool_use TodoWrite (who=chef)
  N-->>B: plan
  B-->>U: ev plan (Max walks to the board)
  C-->>N: assistant tool_use Agent ×k (ids toolu_…)
  N-->>B: hire ×k (present += ids)
  B-->>U: ev hire (robots walk to role desks)
  C-->>N: stream_event / assistant with parent_tool_use_id=toolu_…
  N-->>B: think / typing / say / act / act_done (who=toolu_…)
  B-->>U: ev … (typing not logged)
  C-->>N: control_request can_use_tool
  N-->>B: ask{requestId, who via whoOfTool}
  B-->>U: ev ask (AskBar, alert over robot)
  U->>S: {t:'answer', requestId, allow}
  S->>B: answer()
  B->>C: stdin control_response allow/deny
  B-->>U: ev ask_done
  D-->>B: fs.watch change (350 ms debounce)
  B-->>U: ev file{by = writers[path] ?? 'chef'} (+ version copy)
  C-->>N: tool_use SubagentHandback (subagent) / tool_result for Agent id
  N-->>B: report, leave (present -= id)
  B-->>U: ev report, leave (robot delivers, exits)
  C-->>N: result (turn end)
  N-->>B: onResult → ignored if present non-empty, else finish()
  B-->>U: ev end, {t:'mission'} (status done)
  Note over B,C: 15 min idle → proc.stop(); next say → spawn --resume sid
```

---

## 4. Where Things Live

| Path | Responsibility | Upgrade touchpoints |
|---|---|---|
| `server/index.ts` | HTTP static + CSP, `/apercu/` sandboxed preview, `/ws` origin check, `handle()` dispatch, `broadcast` to all clients, signals. | New `ClientMsg` cases (worker-targeted say/stop/answer/reply); `findClaude` becomes per-CLI detection. |
| `server/bureau.ts` | Mission lifecycle, `Current`/`Live`, spawn/resume, `record`, file watch, versions, replay, team history, path containment (`inside`, `previewPath`). | Becomes supervisor: workers map, task DAG, worktree lifecycle, completion rule, per-worker recovery. |
| `server/claude.ts` | `findClaude`, `ClaudeProcess` (spawn, stdin writes, interrupt, stop, kill), `Normalizer` (stream-json → `OfficeEvent`). | Split into a CLI-adapter interface + claude adapter; codex/gemini adapters alongside. |
| `server/team.ts` | Hardcoded 5-role team (`--agents` JSON), `SESSION_TOOLS`, `ALWAYS_ALLOWED`, Max's system prompt (`chefPrompt`). | Max's prompt must describe office-provided tools (e.g. MCP `start_worker`, `send_message`); still has original brand text "VibesMoney" (`team.ts:8, 67`). |
| `shared/protocol.ts` | All wire types and `OfficeEvent`. | Additive only (see constraints). |
| `shared/activity.ts` | `ROLES`, `ROLE_TOOLS`, `TOOL_INFO`, `roleOfType`, `NAMES`, `describeAct`, `permissionText`, `countStats`. Claude tool names hardcoded. | CLI-specific action mapping must land here or in adapters. |
| `src/net/link.ts` | WebSocket connect/reconnect, demo fallback, `playReplay`, `stopReplay` (reconnect as resync). | Replay guards for any new `ServerMsg`. |
| `src/state/store.ts` | zustand single-mission state; `receive` (ServerMsg) and `apply` (OfficeEvent). | Worker roster, per-worker status (idle/blocked/asking), message threads, multiple asks. |
| `src/state/bus.ts`, `src/engine/instance.ts` | Event pub/sub into `world` and `director`; `reset`. | — |
| `src/engine/world.ts` | Actors, seats, A* walking, deliver/exit choreography, `ask` hand-raise, demo actors. | Long-lived workers (no exit on report), re-hire, seat capacity. |
| `src/engine/layout.ts` | 16 role desks, zones, overflow and deliver spots on a 22×16-tile room. | Seat policy for many/CLI-typed workers. |
| `src/engine/camera.ts` | Director reacting to event kinds. | New kinds need shots or are ignored. |
| `src/engine/robots.ts` | `robotSprite(role, …)` — sprites keyed by role. | CLI badge/colour (not read by explorers). |
| `src/ui/Dialog.tsx` | Max's dialog, Composer (new/steer/retouch), AskBar. | Recipient selection, free-form question answers. |
| `src/ui/Panel.tsx`, `Rooms.tsx`, `Modals.tsx`, `interact.ts` | Side panel (plan, team, feed), agent/team/machine/files rooms (read-only agent card), clicks. | Per-worker composer, worktree/branch/diff display, DAG view; copy that says "real Claude Code subagents" (`Rooms.tsx:68, 213, 227-228, 296, 318`; `Panel.tsx:60`; `Dialog.tsx:92-93`). |
| `src/ui/tidy.ts`, `src/ui/format.ts` | Path scrubbing (`tidy`, `tilde`). | Worktree/repo paths must go through these. |
| `public/demo/mission.json`, `scripts/make-demo.ts` | Recorded mission (189 events) and its builder. | Must keep replaying unchanged. |
| `<BUREAU_DIR>/.bureau/{state.json, missions/<id>.jsonl, versions/}` | Persistent state, event logs, file versions. | Worker/session/worktree records need a home (state.json schema is `{missions, settings}`). |

---

## 5. Gotchas

1. **Agent identity is a Claude tool_use id.** `hire.id` = `Agent` tool_use id; all teammate events use
   `who = parent_tool_use_id`. Independent workers have no such id, so the server must mint ids. `whoOfTool`, `present`,
   `writers`, `reported`, `pendingInputs` are per-Normalizer (per process) and vanish on respawn/resume; only `names` is
   per-mission (`bureau.ts:73, 237`).
2. **Ordering contract: `hire` before anything about that `who`.** The store silently drops `act/say/typing/report/leave`
   for unknown `who` (`store.ts:260-311`); the world's `ask` falls back to Max's head (`world.ts:341`).
3. **Re-hiring the same id is not idempotent in the store.** `hire` appends to `order` unconditionally (`store.ts:279`
   ) → duplicates in `teamList`; the world skips if the actor still exists (`world.ts` `if (this.actors.has(ev.id))
   break`) but creates a new robot after `leave` removed it. A follow-up to a "stable" worker id needs a new event or
   dedup.
4. **`report` is once per robot in the world** (`a.reported`, `world.ts:316`), the store overwrites. `leave` with
   `ok && !reported` triggers a delivery anyway (`world.ts:329`).
5. **`end` is mission-global and destructive**: world exits every non-Max robot (`world.ts:351`), store clears all
   `asks` and `busySince` (`store.ts:334-345`), server cancels pending permission requests (`bureau.ts:295`). Long-lived
   workers or questions surviving a Max turn end break against this.
6. **A successful Max `result` is ignored while subagents are present** (`bureau.ts:274`). Today Max blocks on
   foreground subagents, so a turn end ≈ mission end. With out-of-process workers, Max's turns end long before the work
   does; mission completion needs a new rule (DAG done + lead final message, or explicit).
7. **`ask_done` in the world decrements the first actor with `asks > 0`, not the asker** (`world.ts:346-348`) — a latent
   bug that only shows with concurrent asks from different workers. AskBar shows only the first ask
   (`Dialog.tsx:119-129`); `askOf` shows one per robot.
8. **`say` has no recipient** (`protocol.ts:102`, `index.ts:143-145`) and every `say` is logged as `start`, which in the
   client resets Max's bubble, sets `busySince`, and adds a "나" feed line. Reusing `start` for user→worker messages
   would misattribute them to Max.
9. **`hello` restores from the in-memory log capped at 8000 events** (`bureau.ts:48, 339`); `replay` reads the full
   JSONL. A long multi-worker mission could drop its early `hire`s from `hello` and orphan later events.
10. **Settings and rules are snapshotted at spawn**; a running process keeps old model/permission/team until it idles
    out (15 min) or a new mission starts (`bureau.ts:229-243`).
11. **File attribution is heuristic.** Only Write/Edit/MultiEdit `file_path` is tracked; Bash-made files are credited to
    `'chef'`. All agents share one cwd today. Version filenames squeeze `by` to `[\w-]{1,64}`.
12. **The watcher ignores dot-paths and `node_modules`** (`bureau.ts:350`) and only watches the mission folder. Worktrees
    placed under a dot-dir in the folder, or outside it, will never produce `file` events; a real git repo as the
    mission folder means `fs.watch` on a potentially huge tree.
13. **Path containment is lexical.** `inside()` / `previewPath()` use `path.resolve` + `startsWith(folder + sep)` against
    `MissionInfo.folder` (`bureau.ts:408-409, 479-480`) and don't resolve symlinks. Files in worktrees outside the
    mission folder are unreadable/unpreviewable by design today.
14. **Broadcast is global.** Every tab gets every `ev` (`index.ts:50-53`); the store filters by `mission.id`
    (`store.ts:205`). There is no per-agent channel and no state snapshot message; "resync" = close and reconnect
    (`link.ts:99-101`).
15. **UI reads the world directly** (`Rooms.tsx:56, 285`, `interact.ts:49`): store `agents` and world `actors` are two
    ledgers that must stay in step; adding/removing actors must call `rosterChanged()` or bubbles break.
16. **`demo-` id prefix is special** in the world (fake activity, `world.ts:457, 516`). Minted worker ids must avoid it.
17. **Unknown control requests are refused at once** to avoid deadlock (`claude.ts:142-144`); unparsable stdout lines are
    swallowed (`claude.ts:104-105`) — new adapters will want parse diagnostics.
18. **Residual fork artifacts**: `fr-FR` time formatting in `Rooms.tsx:104, 159`; "VibesMoney" in prompts; CLAUDE.md
    mentions voice files but `public/voice/` does not exist (Max speaks via Web Speech `ko-KR`, `src/audio/voice.ts`).
19. **Quota is Claude's 5-hour window only** (`claude.ts:222-226`, `protocol.ts:97`); `hello.claude: ClaudeInfo` is a
    single CLI install check.

### Explorer open questions (unresolved, flagged honestly)

- Claude: behaviour of a `user` message written to stdin **mid-turn** (queued vs injected) is not verified; the UI copy
  "단계 사이에 읽어요" suggests between-step pickup. `--permission-prompt-tool stdio` is used but hidden from `--help`.
  Provenance/stability of `SubagentHandback` and `tool_use_result.handbackReport` is unknown.
- Codex: exact `codex exec --json` field shapes (only token names seen in the binary); what exec does when a command
  needs approval; whether `-c mcp_servers.<n>…` works for exec; whether `dynamicTools` is usable outside
  `--experimental`; `turn/steer` timing; multi-thread isolation in one app-server.
- Gemini: ACP `initialize` capabilities (`loadSession`), `mcpServers` transport support, whether subscription/OAuth auth
  passes non-interactively in headless/ACP; signal-termination behaviour; how strictly resume is tied to the cwd hash.
- Cross-CLI: auth/token-refresh contention and shared rate limits when several headless processes run at once.
- Client: exact role coupling inside `robots.ts`, `hits.ts`, `camera.ts`, `Modals.tsx`, `Strips.tsx`, `TopBar.tsx`
  was only grepped.
- `agentOfTask` (`claude.ts:172, 259`) is written but never read — leftover or intended.

---

## 6. Constraints for the redesign

Hard facts a design must respect. Evidence is file:line at `91f32e6` or a command.

### 6.1 Backward-compatible replay of `Logged[]`

- C1. Logs are `Logged = {at, ev: OfficeEvent}` (`protocol.ts:65`), persisted one per line in
  `.bureau/missions/<id>.jsonl` (`bureau.ts:340`) and shipped in `public/demo/mission.json`. They are re-applied verbatim
  by `playReplay` (`link.ts:75`, `live=true`) and by `hello` restore (`store.ts:189-192`, `live=false`), and parsed by
  `teamHistory` for `hire/report/leave` (`bureau.ts:414-440`). **No existing event kind or field may be removed,
  renamed, or change meaning.** New fields must be optional; new kinds must be additive.
- C2. Unknown kinds are already safe: no `default` in `store.apply` (`store.ts:242-350`), `World.apply`
  (`world.ts:244-376`), or `Director.event` (`camera.ts:76-98`); `bus.emit` still fires (`store.ts:351`). New kinds must
  handle both `live` branches (snap vs animate).
- C3. `MissionInfo` must stay readable without new fields: the demo has no `sessionId`, and `folder` is relative
  (`'미션/<name>'`, `make-demo.ts:20`). Making anything newly required breaks the demo and old `state.json`
  (`bureau.ts:132-136` merges loosely).
- C4. Recorded `who` values are `'chef'` or `toolu_…` (demo: 7 `toolu_` ids + `chef`); `hire` fields are
  `id, role, type, name, task, prompt`. Role keys, agent type names (`chercheur`, `developpeur`…), event names, and voice
  line names **must stay French** because saved missions depend on them (repo `CLAUDE.md`, "내부 식별자는 프랑스어 그대로 둔다").
- C5. New worker ids must not start with `demo-` (`world.ts:457, 516`) and should be `[\w-]` so version filenames keep
  them (`bureau.ts:382`, `:396` regex `^(\d+)__([\w-]*)`).
- C6. Any new `ServerMsg` that mutates mission state must be ignored while `replaying` (pattern at
  `store.ts:188, 199, 205, 209`). New `ClientMsg`s are harmless in demo (`link.ts:112-113` replaces `send` with a toast).
- C7. `typing` is never persisted (`bureau.ts:337`); high-frequency per-worker deltas should follow the same rule.

### 6.2 Security model

- C8. Bind `127.0.0.1` only (`index.ts:24`, `server.listen(port, HOST)`); WebSocket accepted only on `/ws` with an
  `Origin` in `localhost|127.0.0.1:PORT` (+5174 in `--dev`) (`index.ts:107-118`). This origin check is the *only*
  authentication; static HTTP and `/apercu/` have no origin check. `maxPayload` 1 MB; strings capped by `str()`
  (`index.ts:108, 136`).
- C9. App HTML is served with a strict CSP (`script-src 'self'`, `connect-src` to the WS only) (`index.ts:27-31`);
  generated sites are served only under `/apercu/<missionId>/…` with `sandbox allow-scripts allow-forms allow-popups
  allow-modals` (opaque origin) (`index.ts:43, 84-103`). Any worktree preview must keep this.
- C10. Path containment for read/open/versions/preview is `path.resolve` + `startsWith(MissionInfo.folder + sep)`
  (`bureau.ts:408-409, 479-480`), lexical, no symlink resolution. Worktrees outside the mission folder need an explicit,
  equally strict allow-root model.
- C11. Claude runs `--restricted` with `--tools` = `SESSION_TOOLS` and subagents limited to `ROLE_TOOLS[role]`
  (`claude.ts:81`, `team.ts:51, 59-62`); per CLAUDE.md "팀은 `--restricted`로, 자기 직무의 도구만 가지고 일한다". Per
  `claude --help` (2.1.322), `--restricted` confines file tools to the cwd + `--add-dir`, refuses
  `bypassPermissions`, and requires the permission handler to approve writes to **git** and settings files — a code
  worker that commits in its worktree will raise `ask`s unless the design accounts for it. MCP servers still load under
  `--restricted` unless `--strict-mcp-config`.
- C12. Subscription, not API billing: `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` removed from the child env unless
  `BUREAU_USE_API_KEY=1` (`claude.ts:99`, `bureau.ts:243`). Equivalent decisions are needed for `OPENAI_API_KEY`/`CODEX_HOME`
  and `GEMINI_API_KEY`/`GEMINI_CLI_HOME`.
- C13. Never mutate the user's persistent CLI config: `claude mcp add`, `codex mcp add`, `gemini mcp add` write permanent
  settings (explore-clis §Non-Obvious 8). Inject per run (`claude --mcp-config … --strict-mcp-config`;
  codex `-c mcp_servers.…` [inferred] or app-server `thread/start.config`; gemini via
  `GEMINI_CLI_SYSTEM_SETTINGS_PATH`/`GEMINI_CLI_HOME` or ACP `session/new.mcpServers`).
- C14. Today subagent depth is 1 and builtin agents are off (`claude.ts:93-97`). If Max gains office tools to start
  workers, those tools are the only spawn path and must be pre-allowed (e.g. `--allowedTools mcp__office__*`) or headless
  calls will block on approval.

### 6.3 Per-CLI capability differences (installed: claude 2.1.322, codex-cli 0.167.1, gemini 0.55.1)

| Capability | claude `-p` stream-json | codex `exec --json` | codex `app-server` (JSON-RPC, `[experimental]`) | gemini `-p -o stream-json` | gemini `--acp` (JSON-RPC) |
|---|---|---|---|---|---|
| Long-lived, multi-turn over stdin | Yes (`claude.ts:127-129`) | No — stdin read once at start | Yes (`turn/start` per turn) | No — stdin read once | Yes (`session/prompt`) |
| Host answers tool approvals | Yes, `control_request can_use_tool` → `control_response` | **No channel**; sandbox mode is the policy | Yes, `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` → `{decision}` | **No**; headless `ask_user` → deny (policy-engine.md:117); must pre-decide via `--approval-mode`/`--policy` | Yes, `session/request_permission` → `outcome` |
| Mid-turn steer | Write `user` to stdin (effect mid-turn unverified) | No | `turn/steer{expectedTurnId}` | No | No (cancel + new prompt) |
| Free-form question to user | Disabled by office (`--disallowedTools AskUserQuestion`); chat-only | No | `item/tool/requestUserInput` | No | No native (could be an MCP tool) |
| Interrupt | `control_request interrupt` | SIGTERM | `turn/interrupt` | SIGTERM (may exit without `result`) | `session/cancel` |
| Resume / follow-up after exit | `--resume <session_id>` (already used) | `exec resume <thread_id>` (never `--last` in parallel) | `thread/resume` | `-r <uuid>` **in the same cwd** (sessions stored per cwd hash) | `session/load` if capability advertised |
| Host pre-assigns session id | `--session-id <uuid>` | No (read `thread.started`) | returned by `thread/start` | `--session-id <uuid>` | returned by `session/new` |
| Working dir | process cwd + `--add-dir` | `-C/--cd`, `--add-dir` | `thread/start.cwd` | process cwd, `--include-directories` | `session/new.cwd` |
| One-shot MCP injection | `--mcp-config` (+`--strict-mcp-config`) | `-c mcp_servers.…` [inferred] | `thread/start.config`, or `dynamicTools` (experimental) | settings-file env override only | `session/new.mcpServers` |
| Thinking events | `stream_event` thinking | `reasoning` item | `item/reasoning/*Delta` | **None** | `agent_thought_chunk` |
| Plan/todo events | `TodoWrite` tool_use | `todo_list` item | `turn/plan/updated` | **None** | `plan` |
| Token usage | `task_notification.usage`, tool_result | `turn.completed.usage` | `thread/tokenUsage/updated` | `result.stats` | `usage_update` |
| Rate-limit signal | `rate_limit_event` five_hour | ? | `account/rateLimits/updated` | **None** | ? |
| Subagent attribution | `parent_tool_use_id` | n/a | `subAgentActivity`, `collabAgentToolCall` items | **None** | n/a |
| Sandbox / tool restriction | `--restricted`, `--tools` | `-s read-only\|workspace-write\|danger-full-access` | `sandbox`, `approvalPolicy` | `-s` (docker/podman/sandbox-exec), policy files | `setSessionMode` |
| Event id for act pairing | `tool_use.id` | `item.id` | `item.id` | `tool_id` | `toolCallId` |
| Schema stability | stable flags; `--permission-prompt-tool` hidden | field shapes unverified | marked experimental; generate schema per installed version (`codex app-server generate-json-schema`) | documented 6 event types | documented |

Consequences that are facts, not choices: only claude, codex app-server, and gemini ACP can surface `ask`/approval
round trips; codex exec and gemini `-p` must have policy decided before launch and receive follow-ups as new processes
(`resume`). codex exec (snake_case JSONL) and app-server (camelCase JSON-RPC) are different schemas — supporting both
means two adapters. Built-in `--worktree` flags (claude `-w`, codex `--worktree`, gemini `-w` behind
`experimental.worktrees`) differ in location and cleanup; the office owning `git worktree` and passing only cwd is the
portable option. Nothing in sections 6.3 was exercised against a model (no quota spent); rows marked `?`/[inferred] need
a small paid probe to confirm.

### 6.4 Git worktree facts (git 2.45.1, verified in a throwaway repo)

- C15. A branch can be checked out in only one worktree (`fatal: 'x' is already used by worktree at …`) → one unique
  branch per parallel code worker.
- C16. `git worktree remove` refuses dirty/untracked trees without `--force`; `git branch -d` refuses unmerged branches
  (safe default for not losing worker output); folder-only deletion leaves `prunable` metadata → `git worktree prune`.
- C17. `git merge-tree --write-tree <a> <b>` pre-checks conflicts without touching any work tree; the main checkout is
  unaffected by commits in worktrees.
- C18. Today's mission folders are **not** git repos and the watcher ignores `.`-paths (`bureau.ts:350`); supporting both
  "mission folder" and "real repo" missions means the watcher root, containment root (C10), and `file.by` attribution all
  become per-worker or per-worktree.

### 6.5 Layout and stage limits

- C19. The world is a 352 × 256 px canvas (16 px tiles, 22 × 16) drawn in code; no external images (`CLAUDE.md`; new
  furniture → `furniture.ts` + `layout.ts`, clickable → `hits.ts` + `interact.ts`).
- C20. 16 desks, fixed by role: recherche 6, code 3, design 2, redaction 3, analyse 2 (`layout.ts:62-71`); `assignSeat`
  only gives a matching-role desk (`renfort` may take any) (`world.ts:222-225`); then 8 overflow standing spots, and
  every robot beyond those stacks on `SPOTS.overflow[0]` (`world.ts:227-230`, `layout.ts:113`); 6 deliver spots, random
  beyond (`layout.ts:111`, `world.ts:393-395`). Zones are role-labelled rugs (`layout.ts:42-49`). So >3 code workers
  already overflow, and CLI kind or worktree has no spatial home.
- C21. `Role` is a closed union of 7 (`protocol.ts:6`), sprites are keyed by role (`robotSprite(role, …)`, `robots.ts:291`), name pools
  per role (`activity.ts:49-58`). CLI kind must be an orthogonal attribute, not a new role, unless the union, sprites,
  pools, seats and copy all change together (and C4 keeps old keys).
- C22. Max is a permanent world actor `'chef'` re-created by `resetAll` (`world.ts:124, 146`) and a separate store field
  (`store.ts:70`); every handler branches on `who === 'chef'`. Keeping `'chef'` as Max's `who` preserves C1.

### 6.6 Korean UI and display rules (repo `CLAUDE.md`)

- C23. All user-facing text is Korean, friendly 해요체, short sentences (beginners). Includes new worker states, question
  prompts, error/toast strings, and server-side messages that become events or toasts (e.g. deny text
  `claude.ts:136`, error text `bureau.ts:313, 321-323`).
- C24. Never show a full path or username: run text through `tidy()` / `tilde()` (`src/ui/tidy.ts`, `src/ui/format.ts`).
  `tidy` only knows `mission.folder`, the office dir, and `/Users|/home|/tmp|/var/...` patterns (`tidy.ts:5-12`);
  worktree and repo paths must be covered too. `make-demo.ts:18` scrubs only the mission folder and home dir.
- C25. Honest disclosure: UI copy currently promises "real Claude Code subagents" (`Rooms.tsx:68, 213, 227-228, 296,
  318`; `Panel.tsx:60`; `Dialog.tsx:92-93`); with codex/gemini workers this copy and `hello.claude: ClaudeInfo`
  (single install check, `protocol.ts:67, 117`) must state which CLI really runs.

### 6.7 Lightness rules

- C26. Draw ≤ 24 fps when active, ≤ 8 fps idle, nothing when the tab is hidden, ~1 ms per frame
  (`Office.tsx:79-120`, `CLAUDE.md`). No 3D, no heavy libraries. More robots and per-worker streams must not break this
  (e.g. coalesce deltas server-side like the 120 ms `typing` throttle, `claude.ts:284`).
- C27. zustand selectors returning new arrays/objects must use `useShallow` (`CLAUDE.md`), relevant for any worker
  roster/thread selectors.
- C28. Server code in `server/` and `shared/` is run by Node type stripping: `.ts` import extensions, no `enum`,
  `namespace`, or parameter properties (`server/tsconfig.json` `erasableSyntaxOnly: true`, `allowImportingTsExtensions`);
  `package.json` engines `node >=22.18`. `npm run check` and `npm run build` must pass before a PR. Runtime deps are
  small (`ws`, React, zustand, marked, fonts); adding a JSON-RPC or git library is a weight decision.

### 6.8 Testing without subscription spend

- C29. There is no automated test suite (`package.json` scripts: `start, dev, build, serve, check`). The sanctioned way to
  exercise the UI without spending quota is replay: `H` → "다시 재생", the offline demo, and `window.__bureau`
  (`store`, world, camera, `playReplay(mission, log, speed)`), plus `window.__CAPTURE` for frame-stepped capture
  (`CLAUDE.md`). A redesign should keep new behaviour expressible as `Logged[]` so it can be replayed (and ideally ship
  fake-adapter fixtures that emit recorded CLI output), since real codex/gemini/claude runs consume the user's quota.
  The CLI explorer deliberately ran no model; every [inferred] adapter detail in 6.3 is unverified for that reason.

### 6.9 Single-mission scope (explicitly out of scope now, but don't paint into a corner)

- C30. `Bureau.current` is one field (`bureau.ts:110`); `start` refuses while working (`:178`); `hello.current` is one
  object (`protocol.ts:117`); `ev` routes by `missionId` only and the store drops other missions (`store.ts:205`);
  stats/`busySince`/`workMs` are mission-global. Parallel missions come later, so new worker/task state should be keyed
  by `missionId` rather than hung off `current`.
- C31. On server restart, `working` missions become `stopped` with no process recovery (`bureau.ts:138-139`). Workers
  that outlive a server restart (detached processes, leftover worktrees) need an explicit reconcile/prune story
  (`git worktree prune`, stored session/thread ids per worker).
