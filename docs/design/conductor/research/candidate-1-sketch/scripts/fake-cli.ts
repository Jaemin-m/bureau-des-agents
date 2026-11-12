// Sketch: test harness without subscription spend.
//
// ── scripts/fake-cli.ts (NEW) ──
// One executable that impersonates claude, codex app-server, or gemini --acp by replaying a cassette.
// Drivers find binaries via BUREAU_CLAUDE_BIN / BUREAU_CODEX_BIN / BUREAU_GEMINI_BIN, so a scenario points them at
//   a tiny wrapper:  #!/bin/sh\nexec node <repo>/scripts/fake-cli.ts --as codex --cassette "$BUREAU_CASSETTE_DIR/codex-$BUREAU_FAKE_ROLE.jsonl" "$@"
// (probe(): `--version` is answered from the cassette header.)
//
// Cassette = JSONL recorded by the Runner when BUREAU_RECORD=<dir> (raw lines, both directions, relative ms):
//   {"h": {"as":"codex","version":"0.167.1","argv":[…]}}
//   {"in":  {"method":"initialize"}}                       ← expectation: wait for an inbound line matching this subset
//   {"out": {"id":"$in.id","result":{…}}, "dt": 12}       ← emit; "$in.id" substitutes the matched request's id
//   {"mcp": {"tool":"done","args":{"summary":"…"}}}       ← call the office MCP endpoint (url + token from argv/env/
//                                                           --mcp-config file, exactly as the real CLI would)
//   {"approve": {"out": {…request…}, "expect": "allow"}}  ← emit a permission request, wait for the host's answer
//   {"exit": 0}
// Matching is by subset on method/type so ids, timestamps and tokens may differ between record and replay.
// Speed: BUREAU_FAKE_SPEED=0 ⇒ no delays (unit runs); 1 ⇒ recorded timing (browser demos).
// Recording scrubs: home dir, office dir, repo roots → placeholders (same rule as make-demo.ts, plus repo paths).

export interface CassetteHeader { as: 'claude' | 'codex' | 'gemini'; version: string; argv: string[] }
export type CassetteLine =
  | { h: CassetteHeader }
  | { in: Record<string, unknown> }
  | { out: Record<string, unknown>; dt?: number }
  | { mcp: { tool: string; args: unknown } }
  | { approve: { out: Record<string, unknown>; expect: 'allow' | 'deny' } }
  | { exit: number };

export declare function playCassette(lines: CassetteLine[], io: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream }, mcp: { url: string; token: string } | null): Promise<number>;

// ── scripts/scenario.ts (NEW) ──
// Runs the real server modules (Bureau + MissionRun + Runners + drivers + MCP endpoint on an ephemeral port) against a temp
// BUREAU_DIR and fake bins, drives ClientMsgs from a scenario file, and compares the resulting Logged[] (minus `at`)
// with a golden file. Output log is replayable in the browser (`H` → 다시 재생) — so every scenario doubles as a demo.
//   scenarios/folder-research-write.json : Max plans research(claude) → writing(gemini, after research); finish
//   scenarios/repo-two-branches.json     : temp git repo; build(codex) ∥ test(claude) → review(claude, after both);
//                                          asserts branches, integration start point, merge refused on dirty checkout
//   scenarios/ask-reply.json             : worker asks user; user replies via say{to, replyTo}; worker done
//   scenarios/followup-after-end.json    : mission ends; user messages a gone worker; re-entry; end again
//   scenarios/crash-restore.json         : fake worker exits mid-turn twice; second time server is restarted between;
//                                          asserts interrupted → resume turn → idle, no duplicate msg delivery
export interface Scenario {
  workspace: 'folder' | 'repo';
  /** which cassette each (who|role) uses */
  cassettes: Record<string, string>;
  steps: ({ send: Record<string, unknown> } | { waitFor: Record<string, unknown> } | { restartServer: true })[];
  golden: string;
}

// ── test/*.test.ts (NEW, `npm test` = node --test test/) ──
// pure: foldMission (old demo log folds without throwing; every hire maps to a worker; re-hire dedupes),
//       validatePlan (cycle, unknown dep, edit-after-start, idempotent resubmit), schedule (limits, finish rule),
//       step (every row of the transition table), trimLog (never drops structural kinds)
// git:  worktrees.ts in mkdtemp repos — ensureWorktree twice ⇒ same ref; dirty release ⇒ 'kept' + commit on branch;
//       archive ⇒ ref recoverable; startPointFor conflict detection; assertInside rejects symlink escape
// replay guard: public/demo/mission.json folded by the NEW store equals a stored snapshot of the OLD store's fields.
export {};
