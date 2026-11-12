// Sketch: server/agents/claude.ts (MOVED from server/claude.ts, shrinks).
// Headless mode: `claude -p` stream-json in/out, one long-lived process per conversation (as today).
//
// What changes vs today's ClaudeProcess + Normalizer:
//   - no --agents, no Agent tool, no hire/leave/report inference: workers are separate processes now;
//     parent_tool_use_id handling, `present`, `agentOfTask` are deleted. The Normalizer emits Signals, not OfficeEvents.
//   - office tools arrive through MCP: --mcp-config <0600 temp file> --strict-mcp-config, pre-allowed with
//     --allowedTools mcp__office__* (C13, C14). The user's own MCP servers/settings are not loaded (--restricted + strict).
//   - --session-id <uuid> on a fresh launch, so the resume token is known before the first byte of output (crash-safe).
//
// argv (fresh):  -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
//                --permission-prompt-tool stdio --permission-mode <auto|acceptEdits> --restricted
//                --tools <claudeTools(powers)> --allowedTools <readOnly(powers)>,mcp__office__*
//                --disallowedTools AskUserQuestion --append-system-prompt <instructions>
//                --mcp-config <file> --strict-mcp-config [--model m] [--add-dir d]… --session-id <uuid>
// argv (resume): same, with --resume <uuid> instead of --session-id
//
// Mapping (wire → Signal), reusing today's Normalizer logic:
//   system/init                         → ready{resume:'claude:'+session_id, model, auth}
//   stream_event thinking start         → think          text_delta (throttled 120 ms) → typing
//   assistant text                      → say            assistant tool_use TodoWrite → todo
//   assistant tool_use mcp__office__*   → (ignored: the office sees the call on its MCP endpoint; no double act)
//   assistant tool_use other            → act (describeAct), path = input.file_path for Write/Edit/MultiEdit
//   user tool_result                    → act_done
//   control_request can_use_tool        → approval (id = request_id); other subtypes refused at once (gotcha 17)
//   control_cancel_request              → approval_gone
//   result                              → turn_end{ok: !is_error, text: result, interrupted: subtype==='error_during_execution' && interruptAsked}
//   rate_limit_event                    → quota
//   exit before init while resuming     → resume_failed (today's onExit special case, now generic in Runner)
// Control:
//   prompt(text)   → stdin {"type":"user",…}
//   approve(id,b)  → stdin control_response allow(updatedInput=original) | deny(Korean message)
//   interrupt()    → stdin control_request {subtype:'interrupt'}
//   end()          → stdin.end(); SIGTERM after 5 s

import type { Driver, Powers } from './driver.ts';

/** Powers → claude built-in tool names. ROLE_TOOLS in shared/activity.ts is derived from this (no hand-synced list). */
export function claudeTools(p: Powers): string[] {
  // Read, Glob, Grep always; + Write, Edit if write; + Bash if shell; + WebSearch, WebFetch if web
  throw new Error('not implemented');
}

export const claudeDriver: Driver = {
  kind: 'claude',
  probe() { throw new Error('not implemented'); },
  launch() { throw new Error('not implemented'); },
};
