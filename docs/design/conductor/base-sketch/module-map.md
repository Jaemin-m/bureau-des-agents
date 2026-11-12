# Module map (candidate 2: "Conductor": pure state machine + level-triggered converge, adapters behind one session interface)

Legend: NEW = added, CHG = changed, DEL = deleted after the cut-over unit, = unchanged.

## server/
| File | Status | Owns (one line) |
|---|---|---|
| `index.ts` | CHG | HTTP/WS/CSP/origin check; maps new ClientMsgs to `Conductor.input`; calls `mountLeadMcp` before static handling. |
| `bureau.ts` | CHG (shrinks) | Mission registry + settings + client set + journal (log/JSONL/versions) + shared `Pool`; one `Conductor` per mission (map keyed by missionId, today one entry). |
| `conductor/model.ts` | NEW | The data model: Task, Worker (phase union), Question, Message, MissionState, NEXT_PHASE. Types and tiny pure helpers only. |
| `conductor/dag.ts` | NEW | validatePlan (cycles, keys, caps), readySet, layers. Pure. |
| `conductor/step.ts` | NEW | `step(state,input,ctx)`: apply + converge, the only place that decides anything. Pure. Includes `quiescent`, `briefFor`. |
| `conductor/text.ts` | NEW | `parseHandback`, `wakeText`, `leadPrompt`, `workerPrompt`. The only place that trusts model prose. Pure. |
| `conductor/shell.ts` | NEW | `Conductor` class: effects executor, session map, persistence (atomic state.json), timers, typing coalescing. The package's public surface. |
| `conductor/boot.ts` | NEW | Load/migrate state.json, reap orphan pids, `workspaces.reconcile`, feed `boot`. |
| `agents/adapter.ts` | NEW | The boundary: Capabilities, SessionSpec, WorkerSignal, AgentSession, AgentAdapter. No wire types. |
| `agents/registry.ts` | NEW | probeAll/adapterFor; the only importer of per-CLI modules. |
| `agents/lines.ts` | NEW | `Proc`: spawn, newline-JSON splitter, 4 KB stderr tail, single exit report, SIGTERM grace. Shared by all adapters. |
| `agents/env.ts` | NEW | `childEnv`: key stripping policy per CLI (C12). |
| `agents/claude.ts` | CHG (from `server/claude.ts`) | argv builder + `claudeMapper` (Normalizer minus subagents) + claude `AgentSession`; lead variant adds MCP flags. |
| `agents/codex-exec.ts` | NEW | codex exec/resume argv + mapper; process-per-turn session. |
| `agents/gemini-print.ts` | NEW | gemini -p argv + mapper; process-per-turn session. |
| `agents/codex-app.ts`, `agents/gemini-acp.ts` | LATER | JSON-RPC session adapters (approvals, steer) behind the same interface. |
| `workspaces.ts` | NEW | git worktree lifecycle, checkpoints, review, merge guard, repo intake. The only module running git. |
| `roots.ts` | NEW | realpath containment (`resolveInside`), replaces lexical `inside()`. |
| `lead-mcp.ts` | NEW | Streamable-HTTP MCP endpoint for Max: 4 tools, token auth. Thin. |
| `files.ts` | NEW (extracted from bureau.ts) | fs.watch + version copies for folder missions; git-status polling for worktrees; `by` attribution. |
| `team.ts` | CHG | Roles' display data stays; `--agents` JSON and Claude subagent definitions DEL; prompts move to `conductor/text.ts`. |
| `claude.ts` | DEL (U7) | replaced by `agents/claude.ts`. |

## shared/
| File | Status | Owns |
|---|---|---|
| `protocol.ts` | CHG additive | New kinds `worker`, `task`, `msg`; optional fields on `hire`, `ask`, `end`, `MissionInfo`, `say`, `start`; `reply`/`retire`/`resume`/`repo_check` ClientMsgs; `agents` on hello. `compactLog`. |
| `activity.ts` | CHG additive | `AGENTS` (label, vendor, badge glyph/colour, strengths line), Korean phase/task labels; `describeAct` stays for claude names, other adapters carry their own tool-name tables. |

## src/
| File | Status | Owns |
|---|---|---|
| `state/store.ts` | CHG | `tasks`, per-agent `phase/agent/thread`, `asks[]` stack, hire dedup, `end.stay`. |
| `net/link.ts` | CHG | Ignore new mission-mutating ServerMsgs while `replaying` (C6); `repo_info`. |
| `engine/world.ts` | CHG | Seat policy + reclaim to lounge, multi-delivery, askOwner, phase postures. |
| `engine/layout.ts` | CHG | `SPOTS.lounge` (sofa), no new desks. |
| `engine/render.ts`, `robots.ts`, `icons.ts` | CHG | Agent chip + phase badges overlay (no new images). |
| `engine/camera.ts` | CHG | Shots for `worker blocked` and `task failed`; others ignored. |
| `ui/Dialog.tsx` | CHG | Recipient chip ("맥스에게 / 에이다에게"), repo picker, ask stack with free-text reply, options buttons. |
| `ui/Rooms.tsx`, `ui/Panel.tsx` | CHG | Worker card (thread, branch, diff stat, 합치기), DAG list; copy that said "real Claude Code subagents" now names the real CLI (C25). |
| `ui/tidy.ts` | CHG | Knows repo label and the worktree root. |

## tests/ and scripts/ (all NEW)
| File | Owns |
|---|---|
| `tests/fake-cli/fake-agent.ts` + `bin/*` | Fake claude/codex/gemini speaking recorded wire formats; script steps incl. real MCP calls. |
| `tests/fixtures/<cli>-<version>/*.jsonl` | Recorded real streams (from `scripts/record-cli.ts`). |
| `tests/scenarios/*.ts` | End-to-end missions with fakes, asserted on Logged[] and git state; outputs are replayable demos. |
| `tests/unit/*.test.ts` | dag, step tables, NEXT_PHASE matrix, handback fuzz, compactLog property, workspaces on temp repos, roots escape cases. |
| `scripts/record-cli.ts` | One-off paid recorder + capability prober (answers the open questions in grounding §5). |

## Who owns which state
| State | Single owner | Persisted where | Readers |
|---|---|---|---|
| Tasks, workers, questions, queued messages, news | `Conductor` (step.ts reducer) | `.bureau/missions/<id>.state.json` (private) | lead-mcp status, UI via projected events |
| Event history (what the user sees/replays) | Bureau journal (append-only) | `.bureau/missions/<id>.jsonl` | client fold, replay, teamHistory |
| Live processes/sessions | Conductor shell's session map | pid+startedAt inside worker.proc only | nobody else |
| Worktree/branch existence | git (truth); `Workspaces` is the only writer | git + `WorkspaceRef` intent record in state | Conductor, files.ts |
| Mission list, settings | Bureau | `.bureau/state.json` | everyone |
| View state | client store (fold of log) | none | UI |
