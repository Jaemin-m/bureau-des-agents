# Synthesis: Conductor (candidate 2) with grafts from candidate 1

The base design is `candidate-2/rationale.md` and `candidate-2/sketch/`. This note records the synthesis decision and every
amendment to the base. Where this note and the base disagree, this note wins.

## Synthesis decision

**Base: candidate 2 (Conductor).** My rubric scoring and the cross-judge (sonnet) agreed independently. The deciding
criterion was the adapter boundary. Candidate 2 uses only CLI modes that `explore-clis.md` verified from help or source
(claude `-p` stream-json, `codex exec --json`, `gemini -p -o stream-json`). Workers report through a CLI-agnostic
`handback` block, so no per-CLI MCP injection is on the critical path. Candidate 1 depended on codex `app-server`,
gemini `--acp` and MCP injection into all three CLIs, all marked inferred, and deliberately dropped the fallbacks.
Candidate 2 also has the stronger convergence story (pure `step` plus level-triggered `converge`, keyed effects, `gen`
fencing, `quiescent()` completion) and puts the riskiest unknowns first (U0).

## Grafts from candidate 1

1. **Worktree safety** (candidate-1 `sketch/server/git/worktrees.ts`, R1-R5).
   - `read` tasks never run in the user's checkout. They get a detached read lens worktree at the mission's `baseSha`.
   - A task with several code upstreams starts from an integration commit built by plumbing only
     (`git merge-tree --write-tree` then `git commit-tree`), so no work tree is touched while composing. A conflict
     marks the task `blocked: upstream conflict` with the branch names.
   - Discarding a branch moves the ref to `refs/bureau/archive/<mission>/<task>`. No `-D` anywhere. Candidate 2's
     sha-confirmed `-D` and `trash.json` are dropped.
   - Office checkpoints run the user's hooks (no `--no-verify`). A failing hook leaves the worktree dirty and kept,
     and the worker card says why. Candidate 2's `branchMoved` guard and orphan quarantine stay.
2. **Compatibility discipline** (candidate-1 "Protocol and replay").
   - `end` keeps its meaning. Candidate 2's `end{stay:true}` is dropped. When `quiescent()` holds, the Conductor emits
     a new additive event `settle{text}` (final summary card, robots stay seated or go to the lounge). `end` and the
     final `leave`s are emitted only on release: a new mission, the "새 미션" button, or shutdown.
   - No new mission-mutating `ServerMsg`. `repo_info` travels as a reply to `repo_check` that is never logged.
   - A demo-fold snapshot test compares the new store against the store fields produced by today's code (captured in
     U1 before any change).
3. **Zero-cost golden source and the later session adapters.**
   - Add candidate 1's `BUREAU_RECORD` tee to today's claude process as unit U0a, so golden logs exist before the paid
     probe and before any refactor.
   - Candidate 1's `codex.ts` and `gemini.ts` mapping tables (app-server and ACP methods, approval and steer notes)
     become the spec for U14.
   - Role powers come from one list, `ROLE_POWERS`, from which today's `ROLE_TOOLS` and each CLI's sandbox mapping are
     derived (no hand-synced lists).

## Amendments from the cross-judge's flaw list

- **Task state is derived, not stored.** A task stores only its run record:
  `run: {k:'pending'} | {k:'running', worker} | {k:'done', result} | {k:'failed', why, attempts} | {k:'cancelled'}`.
  `waiting / ready / blocked` are computed from dependencies by `taskStatus(state, key)`. `Worker` no longer stores
  `taskKey`. A worker's current task is the task whose run points at it. Max is a separate variant of the worker union,
  so a non-lead worker without a task is unrepresentable.
- **Checkpoint guard.** Before an office commit, files over 5 MB and paths matching `.env*`, `*.pem`, `*.key`,
  `id_rsa*` are left unstaged and reported on the worker card. `git add -A` already honours `.gitignore`.
- **Untrusted worker text.** Wake digests wrap worker prose in a fenced block that the lead prompt calls data, never
  instructions. Max's tools can only plan, message, cancel and read status inside his own mission. Merging into the
  user's checkout is a user-only browser action, never a Max tool.
- **Worktree location.** Default `~/.bureau-des-agents/worktrees/<missionSlug>/<taskKey>`, outside `~/Documents`
  (iCloud) and outside the user's repo. Overridable with `BUREAU_WORKTREES`.
- **Message idempotency.** `office_message` takes an optional `requestId`. A repeated id is a no-op (Orca's
  `--retry-request`).
- **Deferred, listed as open:** a per-repo setup command for fresh worktrees (`npm ci`), and a conflict-resolution
  task type. In v1 a conflict blocks the task and Max may plan a follow-up task pinned to an integration worktree.

## Rejected from candidate 1

- Driving codex and gemini only through `app-server` and `--acp` in v1. Kept for U14.
- Worker-side MCP tools (`ask`, `done`). The handback block covers v1. A `handback` tool may replace it in U14 behind
  `WorkerSignal.turn_end`.
- The log as the only state store. A private `state.json` stays, because session ids and absolute paths must not reach
  `Logged[]` or the browser.
- A `finish` tool for Max. `quiescent()` decides completion.

## Delivery sequence (amended)

| Unit | What | Check that ends it |
|---|---|---|
| U0a | `BUREAU_RECORD` tee in today's claude process; capture two golden `Logged[]` from fixtures, zero quota. Capture the demo-fold store snapshot from today's code. | Golden files and snapshot committed under `tests/fixtures/`; `npm run check` green. |
| U0b | One paid probe run (`scripts/record-cli.ts`, user-approved): claude approval and interrupt, MCP over HTTP with `--strict-mcp-config`, codex exec first turn and resume, gemini `-p` first turn and `-r`. | Fixtures per CLI version committed; a probe report answers open questions 1 and 2 of the base. |
| U1 | Protocol additions and the client fold, no server change. | Demo folds to the U0a snapshot; a hand-written new-kind log replays in the browser. |
| U2 | Adapter boundary, claude adapter extracted behind `AgentSession`. | U0a goldens reproduce byte-for-byte except timestamps. |
| U3 | Fake-CLI harness, `npm test` with `node --test`. | Offline in under 10 s; claude adapter conformance passes. |
| U4 | Pure core: model, dag (`taskStatus`), step, converge, handback parser. | Table and fuzz tests green; no `node:*` imports outside the shell. |
| U5 | `workspaces.ts` with the grafted safety rules and `resolveInside`. | Temp-repo tests; user checkout sha and status unchanged in every test. |
| U6 | Conductor shell, boot, lead MCP, folder missions with claude workers. | Dependent two-worker scenario; kill-and-restart converges. |
| U7 | Cut-over: Bureau on Conductor; delete `--agents` and the subagent normalizer. | All scenarios and the demo replay green; one small real claude mission. |
| U8 | Messaging: `say.to`, `reply`, worker thread, question escalation, per-worker stop. | Ask, escalate, reply scenario; replay checked in the browser. |
| U9 | Repo missions: worktrees, lens, integration commits, branch card. | Scenario with fake workers; branches exist; user checkout untouched. |
| U10 | codex exec adapter. | Conformance and fixtures; fake-codex scenario; one tiny real smoke. |
| U11 | gemini `-p` adapter. | Same as U10. |
| U12 | Office visuals for many workers of different kinds. | 12 robots under 1 ms per frame; multi-worker demo replays. |
| U13 | Guarded merge into the user's checkout and archive-ref discard. | Temp-repo tests: clean merge, conflict refused, dirty checkout refused. |
| U14 | Session adapters (codex app-server, gemini ACP) and parallel missions. | Same conformance suite with `approvals:true`. |
