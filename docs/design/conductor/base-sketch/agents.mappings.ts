// server/agents/{claude,codex-exec,gemini-print}.ts (SKETCH): per-CLI argv builders and wire->WorkerSignal mappers.
// Both halves are PURE functions so they are tested against recorded stdout fixtures without spawning anything.
// Shared: lines.ts = Proc helper (spawn, newline-JSON splitter, stderr tail 4 KB, one exit report, SIGTERM-after-grace).
import type { SessionSpec, TurnInput, WorkerSignal } from './agents.adapter.ts';
import type { SessionRef } from './conductor.model.ts';

export interface Launch { bin: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; stdin?: string }
export interface Mapper { feed(line: unknown): WorkerSignal[]; end(): WorkerSignal[] /* flush: guarantees the single turn_end */ }

// ── claude: long-lived, stdin stream-json, approvals, session id pre-assigned ─────────────────────────────
export function claudeLaunch(spec: SessionSpec, sessionId: string): Launch {
  throw new Error('not implemented');
  // claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages
  //   --permission-prompt-tool stdio --permission-mode <auto|acceptEdits> --restricted
  //   --tools <ROLE_TOOLS[role] filtered by access>            // lead: Read,Glob,Grep,WebSearch,WebFetch + mcp (no Agent, no TodoWrite: the board is derived from the DAG)
  //   --session-id <uuid> | --resume <id>                      // pre-assigned => the ref is known before `init`, restart-safe
  //   --append-system-prompt <spec.systemPrompt> [--model m] [--add-dir ...readDirs]
  //   lead only: --mcp-config '{"mcpServers":{"office":{"type":"http","url":"<mcpUrl>"}}}' --strict-mcp-config --allowedTools mcp__office__*,Read,Glob,Grep,WebSearch,WebFetch
  //   env: childEnv('claude', …); no CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH/--agents/--disallowedTools Agent games any more.
  //   Git: workers are told not to run git; office commits. So --restricted's "git writes need approval" never fires for normal work.
}
export function claudeMapper(): Mapper {
  throw new Error('not implemented');
  // today's Normalizer minus everything subagent: no hire/present/whoOfTool/agentOfTask. result -> turn_end (text = last assistant text).
  // control_request can_use_tool -> approval (id = request_id); control_cancel_request -> approval_cancelled; unknown control_request -> refused inside the adapter.
}

// ── codex exec (v1): process per turn, no approvals, policy = sandbox ─────────────────────────────────────
export function codexLaunch(spec: SessionSpec, turn: TurnInput, resume: SessionRef | undefined): Launch {
  throw new Error('not implemented');
  // first turn : codex exec --json -C <cwd> -s <read-only|workspace-write> [-m model] [--add-dir …] [--skip-git-repo-check if cwd is not a repo] - (prompt on stdin: long briefs)
  // later turns: codex exec resume <thread_id> --json [same flags that exec resume accepts] -        // NEVER --last (cwd-filtered "latest", wrong under parallel workers)
  // autonomy 'ask' and 'auto' both map to workspace-write for access 'write' (there is no host approval channel); 'read' -> read-only. Documented in AdapterProbe.note.
  // system prompt: prepended to the first turn text (no flag), repeated on resume turns as a one-line reminder.
  // fields below are from a recorded fixture (unit U0), not from guesses.
}
export function codexMapper(): Mapper {
  throw new Error('not implemented');
  // thread.started{thread_id} -> session | item.started/completed command_execution|file_change|mcp_tool_call|web_search -> act/act_done (event id = item.id)
  // item agent_message -> say (last one remembered as turn text) | reasoning -> think | todo_list -> plan
  // turn.completed{usage} -> usage then turn_end(ok) | turn.failed|error -> turn_end(error) | EOF without either -> end() emits turn_end(error)
}

// ── gemini -p (v1): process per turn, no approvals, --approval-mode fixed at launch ───────────────────────
export function geminiLaunch(spec: SessionSpec, turn: TurnInput, sessionId: string, resuming: boolean): Launch {
  throw new Error('not implemented');
  // gemini -p <turn.text> -o stream-json --skip-trust --approval-mode <plan|auto_edit|yolo> [--session-id <uuid> | -r <uuid>] [-m model] [--include-directories …]
  //   access 'read' -> plan ; 'write' + autonomy 'ask' -> auto_edit (file edits ok, shell denied by headless policy) ; 'write' + 'auto' -> yolo AND `-s` sandbox
  //   cwd MUST equal SessionRef.cwd on resume (sessions are stored per cwd hash): enforced by the Conductor type (SessionRef carries cwd), asserted again here.
  //   system prompt: GEMINI_SYSTEM_MD=<temp file under .bureau/tmp, deleted on exit> (path chosen by us, never from model output)
}
export function geminiMapper(): Mapper {
  throw new Error('not implemented');
  // init{session_id} -> session | message{role:'assistant',delta} -> typing (throttled) and accumulates text | tool_use{tool_id,tool_name,parameters} -> act (id=tool_id)
  // tool_result{tool_id,status} -> act_done | result{status,stats} -> usage + turn_end(ok|error) | exit 53 -> turn_end(error, '턴 한도') | SIGTERM without result -> turn_end(interrupted|error)
  // no thinking/plan events exist: the robot just types. Honest: the card says "생각 과정은 보이지 않아요".
}

// Later (unit U14, same AgentAdapter interface, caps flip to approvals:true/steer:true): codex app-server JSON-RPC, gemini --acp.
