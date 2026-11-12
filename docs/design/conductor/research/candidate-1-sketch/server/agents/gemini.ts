// Sketch: server/agents/gemini.ts (NEW). Headless mode: `gemini --acp` (JSON-RPC 2.0 over stdio), one process per
// worker. `gemini -p -o stream-json` is NOT supported: headless ask_user ⇒ deny means writes/shell silently fail
// under the default mode, and the only fix (yolo) removes the user's say (C-table 6.3).
//
// Launch:
//   spawn gemini --acp [--model m] [--skip-trust]   cwd = spec.cwd, env = spec.env (GEMINI_API_KEY stripped unless opt-in)
//   → initialize{protocolVersion, clientCapabilities:{fs:{readTextFile:false, writeTextFile:false}}}
//     remember agentCapabilities.loadSession and mcpCapabilities.http
//   fresh:  → session/new{cwd, mcpServers:[office]}        office = http entry {type:'http', name:'office', url, headers:[Authorization]}
//                                                          or, without mcpCapabilities.http, the stdio shim:
//                                                          {name:'office', command: process.execPath, args:[server/mcp-stdio.ts], env:[URL, TOKEN]}
//   resume: → session/load{sessionId, cwd, mcpServers} if loadSession, else emit resume_failed (Runner recaps)
//   → setSessionMode(permission==='ask' ? 'default' : 'auto_edit')       [mode ids from initialize/current_mode_update]
//   → ready{resume:'gemini:'+sessionId}
//   instructions: ACP has no system-prompt field and GEMINI_SYSTEM_MD would REPLACE gemini's own prompt, so the
//   driver prepends spec.instructions to the first prompt of a fresh session only.
//   Powers: tools outside powers are refused at the approval step (approval → auto-deny without asking the user),
//   because gemini has no per-session tool allowlist in ACP. read-only roles therefore never write even in auto_edit.
//
// Mapping (session/update.sessionUpdate → Signal):
//   agent_thought_chunk               → think
//   agent_message_chunk (throttled)   → typing; flushed as say at turn end / before a tool_call
//   tool_call{toolCallId, kind, title, locations} → act{kind: from ACP kind (read|edit|execute|fetch|search…), path: locations[0]}
//   tool_call_update{status: completed|failed}    → act_done
//   plan                              → todo         usage_update → usage accumulator
//   AGENT REQUEST session/request_permission{options, toolCall} → approval{id: jsonrpc id}
//   session/prompt response{stopReason} → turn_end{ok: stopReason==='end_turn', interrupted: stopReason==='cancelled'}
//   AGENT REQUEST fs/* or terminal/*  → JSON-RPC error (we advertise no client fs/terminal capability)
// Control:
//   prompt(text)   → session/prompt{sessionId, prompt:[{type:'text', text}]}
//   approve(id,b)  → response {outcome:{outcome:'selected', optionId: b ? allow_once.optionId : reject_once.optionId}}
//   interrupt()    → session/cancel (notification); pending permission requests answered {outcome:'cancelled'}
//   end()          → close stdin; SIGTERM after 5 s
// Sessions are stored per cwd hash: the worktree path is stable for the worker's whole life (worktrees.ts never moves it).

import type { Driver } from './driver.ts';

export const geminiDriver: Driver = {
  kind: 'gemini',
  probe() { throw new Error('not implemented'); },
  launch() { throw new Error('not implemented'); },
};
