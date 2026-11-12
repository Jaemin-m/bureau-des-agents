// server/lead-mcp.ts (SKETCH): the office as an MCP server for Max only. Thin: validate + forward to Conductor.step.
// Transport: Streamable HTTP, JSON responses (no SSE), on the EXISTING http server at POST /lead/<token>/mcp. ~120 lines, no MCP SDK dependency (C28).
// Why HTTP and not a stdio shim: tool calls land in-process in the Conductor (no IPC, no second process to supervise, no unix socket).
//   Fallback if claude's `type:"http"` mcp-config misbehaves (probe in U0): a 40-line stdio shim `node server/lead-shim.ts` that proxies JSON-RPC to the same handler.
// Security (C8, C13, C14):
//   - token = 128-bit random per lead PROCESS, held by the Conductor, revoked when that process exits/parks; compared with timingSafeEqual
//   - request must have Host === 127.0.0.1:PORT|localhost:PORT and NO Origin header (browsers always send one on cross-origin POST; claude's client doesn't)
//   - no CORS headers; body <= 256 KB; only tools/list, tools/call, initialize, ping, notifications/*
//   - mcp config is passed per process (`--mcp-config … --strict-mcp-config`), never `claude mcp add` (user config untouched)
import type { Reply } from './conductor.step.ts';
import type { TaskSpec, TaskKey, WorkerId } from './conductor.model.ts';

/** One table is the source of truth for the JSON Schema Max sees, the validator, and the handler. No hand-synced lists. */
export interface LeadTool<A> {
  name: `office_${string}`;
  /** Korean, written for a model. Includes the contract: "끝나면 턴을 끝내세요. 결과는 사무실이 알려줘요." */
  description: string;
  schema: JsonSchema;
  parse(args: unknown): A | { error: string };        // boundary validation; hand-written, tiny
  run(a: A): Promise<Reply>;
}
type JsonSchema = { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };

export interface LeadCommands {
  plan(specs: TaskSpec[]): Promise<Reply>;                       // office_plan   {tasks:[{key,title,brief,role,agent?,access?,after?}]}  idempotent per key
  message(to: WorkerId, text: string, replyTo?: string): Promise<Reply>;  // office_message {to,text,replyTo?}  answers a question, or follow-up work to a running/finished worker
  cancel(target: { task: TaskKey } | { worker: WorkerId }): Promise<Reply>; // office_cancel
  status(): Promise<Reply>;                                      // office_status  {} -> compact Korean text: tasks (state, worker), open questions, branches
}
// There is deliberately no office_finish: the mission ends when the Conductor says it is quiescent (see step.quiescent), so Max can't forget to, or end early.
// There is deliberately no office_ask_user: Max talks to the user in chat; a worker question the lead leaves unanswered auto-escalates.

export function leadTools(cmds: LeadCommands, installed: readonly string[]): LeadTool<unknown>[] { throw new Error('not implemented'); }
export function mountLeadMcp(opts: { tokens: Map<string, { missionId: string }>; port: number; commandsFor(missionId: string): LeadCommands | null; installed(): string[] }): (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => boolean {
  throw new Error('not implemented');
  // returns true if it handled the request (path starts with /lead/). index.ts calls it before the static handler.
  // TODO: JSON-RPC 2.0 envelope; tools/call -> parse -> run -> {content:[{type:'text',text}], isError}; errors are Korean sentences Max can act on.
}
