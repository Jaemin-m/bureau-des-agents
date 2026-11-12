// tests/fake-cli/* and tests/scenarios/* (SKETCH): the no-subscription harness. `npm test` = `node --test tests/**/*.test.ts` (no new dependency).
//
// Idea: fake CLIs are REAL child processes that speak each CLI's REAL wire format by replaying recorded streams, so the real adapters
// (argv builders + parsers + Proc lifecycle) are exercised end to end. The recordings come from `scripts/record-cli.ts`, run once by a human
// on a subscription (unit U0, a few cents), and are committed as fixtures per CLI version. Nothing else in the repo ever spends quota.
//
//   tests/fake-cli/bin/{claude,codex,gemini}   3-line shell wrappers: exec node --experimental-strip-types ../fake-agent.ts --as <kind> "$@"
//   adapters find them via CLAUDE_BIN / CODEX_BIN / GEMINI_BIN (same mechanism as today's CLAUDE_BIN)
//   FAKE_SCRIPT=<file>   chosen per spawn by a tiny router: the test passes `scripts: Record<'chef'|workerKey, Script>` via FAKE_SCRIPTS_DIR and the fake
//                        picks by the prompt's `[fake:<name>]` tag or by the order of spawns (deterministic).

/** A script = ordered steps, JSONL on disk. `emit` carries a RAW recorded line, so parsers see exactly what the vendor sends. */
export type Step =
  | { emit: unknown }                                         // write this JSON line to stdout (or JSON-RPC message for the session adapters later)
  | { wait: number }                                          // virtual ms: the harness clock drives it when timers are injected, else real setTimeout
  | { expectInput: string }                                   // regexp the next stdin message / argv prompt must match (asserts what the office sent)
  | { writeFile: { rel: string; content: string } }           // simulate the worker editing its worktree/mission folder (cwd of the fake)
  | { mcp: { tool: string; args: unknown; saveAs?: string } } // the fake LEAD makes a real HTTP tools/call to the office (url+token from --mcp-config)
  | { approval: { tool: string; input: unknown; expect: 'allow' | 'deny' } } // claude control_request/response round trip
  | { handback: unknown }                                     // appends a ```handback fenced block to the final assistant message
  | { exit: number | 'crash' | 'hang' };                      // 'crash' = SIGKILL self (restart tests), 'hang' = never exit (stop/kill tests)
export type Script = { name: string; steps: Step[] };

/** A scenario = a mission driven end to end with fakes, asserted on the resulting Logged[] and git state. */
export interface Scenario {
  name: string;
  target: { kind: 'folder' } | { kind: 'repo'; fixture: 'two-commit-repo' };   // repo fixture is built in a temp dir with real git
  scripts: Record<string, Script>;                                             // 'chef' + one per worker key
  steps: ({ user: { say: string; to?: string } } | { user: { reply: string; question: 'last' } } | { advance: number } | { restartServer: true } | { killServer: true })[];
  expect: {
    kinds: string[];                                                           // subsequence of OfficeEvent kinds that must appear in order
    tasks?: Record<string, 'done' | 'failed' | 'cancelled' | 'ready'>;
    git?: { branches: string[]; mainSha: 'unchanged'; mainClean: true };       // the user's checkout is untouched
    endOk?: boolean;
  };
}
export function runScenario(s: Scenario): Promise<{ log: { at: number; ev: unknown }[]; state: unknown }> { throw new Error('not implemented'); }
// The returned `log` is a valid Logged[]: save it to public/demo/multi.json to replay the multi-worker office in the browser (`__bureau.playReplay`) with zero quota.

/** The same suite runs against every adapter (claude, codex-exec, gemini-print, later app-server/acp): one turn_end per turn, kill => single exit,
 *  crash mid-turn => turn_end(error), interrupt => turn_end(interrupted), unparsable lines => diag not crash, stderr tail kept. */
export function adapterConformance(kind: 'claude' | 'codex' | 'gemini'): void { throw new Error('not implemented'); }
