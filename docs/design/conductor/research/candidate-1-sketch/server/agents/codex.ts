// Sketch: server/agents/codex.ts (NEW). Headless mode: `codex app-server --listen stdio://` (JSON-RPC 2.0),
// ONE app-server process per worker (no shared daemon: isolation and kill-ability beat the unknowns of
// multi-thread app-servers, grounding open question). `codex exec --json` is NOT supported: it has no approval
// channel and no stdin follow-ups, and a second schema means a second adapter (C-table 6.3).
//
// Wire types are private to this file, hand-written from `codex app-server generate-json-schema` at 0.167.1.
// probe() runs `codex --version` and checks that the generated schema still contains every method below; if not,
// the CLI is reported as found-but-unusable with a Korean `problem` ("이 Codex 버전은 아직 지원하지 않아요").
//
// Launch:
//   spawn codex app-server --listen stdio://   cwd = spec.cwd, env = spec.env + BUREAU_MCP_TOKEN=<token>
//   → initialize{clientInfo:{name:'bureau', version}}
//   fresh:  → thread/start{cwd, model, sandbox: powers.write ? 'workspace-write' : 'read-only',
//                          approvalPolicy: permission==='ask' ? 'untrusted' : 'on-request',
//                          developerInstructions: spec.instructions,
//                          config:{ 'mcp_servers.office.url': mcp.url,
//                                   'mcp_servers.office.bearer_token_env_var': 'BUREAU_MCP_TOKEN' }}   [inferred keys: probe]
//   resume: → thread/resume{threadId}
//   → ready{resume:'codex:'+threadId}
//   Network: workspace-write keeps network off by default; powers.web ⇒ config 'sandbox_workspace_write.network_access'=true
//   and 'tools.web_search'=true [inferred: probe].
//
// Mapping (notification/request → Signal):
//   item/started reasoning, item/reasoning/*Delta   → think
//   item/agentMessage/delta (throttled 120 ms)      → typing        item/completed agentMessage → say
//   item/started commandExecution                   → act{kind:'bash', id:item.id, label from command}
//   item/started fileChange                         → act{kind:'write'|'edit', path from changes[0]}
//   item/started webSearch                          → act{kind:'search'}     mcpToolCall(server!='office') → act{kind:'mcp'}
//   item/started mcpToolCall(server=='office')      → ignored (seen on the office endpoint)
//   item/completed (status)                          → act_done{ok: status==='completed'}
//   turn/plan/updated                               → todo
//   SERVER REQUEST item/commandExecution/requestApproval, item/fileChange/requestApproval,
//                  item/permissions/requestApproval → approval{id: <jsonrpc id>}; MUST be answered
//   serverRequest/resolved                          → approval_gone
//   SERVER REQUEST item/tool/requestUserInput       → answered at once with an empty answer + note to use the office
//                  `ask` tool (questions go through ONE channel, the office MCP, for every CLI)
//   SERVER REQUEST anything else                    → JSON-RPC error at once (never leave codex blocked)
//   turn/completed{status}                          → turn_end{ok: status==='completed', interrupted: status==='interrupted'}
//   thread/tokenUsage/updated                       → usage accumulator    account/rateLimits/updated → (ignored v1)
//   thread/resume error "not found"                 → resume_failed
// Control:
//   prompt(text)   → turn/start{threadId, input:[{type:'text', text}]}
//   approve(id,b)  → JSON-RPC response {decision: b ? 'accept' : 'decline'}
//   interrupt()    → turn/interrupt{threadId, turnId}
//   end()          → close stdin; SIGTERM after 5 s
// Not used in v1: turn/steer (follow-ups wait for the turn boundary for every CLI — one rule), dynamicTools (experimental).

import type { Driver } from './driver.ts';

export const codexDriver: Driver = {
  kind: 'codex',
  probe() { throw new Error('not implemented'); },
  launch() { throw new Error('not implemented'); },
};
