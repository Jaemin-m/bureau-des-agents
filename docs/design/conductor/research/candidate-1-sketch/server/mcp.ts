// Sketch: server/mcp.ts (NEW). The office as an MCP server, served by the office's own HTTP server.
//
// Why MCP: it is the one host-tool channel all three CLIs load per run without touching user config
// (claude --mcp-config + --strict-mcp-config; codex thread/start.config mcp_servers; gemini ACP session/new.mcpServers).
// Transport: Streamable HTTP subset — POST /mcp, JSON-RPC body, `application/json` response (no SSE needed: every tool
// returns immediately). Methods: initialize, notifications/initialized, tools/list, tools/call, ping. ~150 lines, no dep.
// server/mcp-stdio.ts (≈30 lines) bridges stdio⇄HTTP for a CLI that only speaks stdio MCP (gemini without http capability).
//
// Security (C8 extended):
//   - listens on the same 127.0.0.1 server; POST only; body ≤ 1 MB;
//   - requires `Authorization: Bearer <token>`; tokens are 32 random bytes, minted per Runner launch, mapped to a Caller,
//     revoked on process exit; the token IS the identity (a worker cannot act as Max or as another worker);
//   - any request carrying an `Origin` header is refused (browsers always send one on cross-site POST; CLIs never do),
//     so a web page cannot drive the office even if it guessed a token;
//   - tokens reach claude through a 0600 temp file (--mcp-config <file>), codex/gemini through child env vars, never argv.

import type { Caller, MissionRun, ToolResult } from './orchestra/run.ts';

export interface ToolSpec { name: string; description: string; inputSchema: object }

/**
 * Tool sets are chosen by caller kind, so a worker never even sees `plan`. Descriptions are Korean (the agents work in
 * Korean); names stay English identifiers. Claude sees them as mcp__office__<name>, pre-allowed.
 */
export const LEAD_TOOLS: ToolSpec[] = [
  // plan({tasks:[{key,title,brief,role,agent?,after?}], cancel?, retry?})  — upsert the task DAG; the office starts ready tasks itself
  // message({to, text, replyTo?})                                          — follow-up or answer to one worker (id, name or task key)
  // ask_user({question, options?})                                         — ask 대표님; then end your turn
  // finish({summary})                                                      — end the mission (refused while work remains)
  // board()                                                                — current DAG + workers + open questions
];

export const WORKER_TOOLS: ToolSpec[] = [
  // ask({question, to?: 'lead'|'user', options?})  — ask, then end your turn; the answer arrives as your next message
  // done({summary})                                 — final report; then end your turn
];

export class OfficeMcp {
  constructor(resolveRun: (missionId: string) => MissionRun | null) { throw new Error('not implemented'); }

  /** url for LaunchSpec.mcp (http://127.0.0.1:<PORT>/mcp) */
  readonly url!: string;

  mint(caller: Caller): string { throw new Error('not implemented'); }
  revoke(token: string): void { throw new Error('not implemented'); }

  /**
   * Called by index.ts for POST /mcp.
   * TODO: reject Origin / missing or unknown token (401) → parse JSON-RPC → tools/list by caller kind →
   *       tools/call: validate args against the tool's schema (types, lengths via str()) → run.tool(caller, name, args)
   *       → {content:[{type:'text', text}], isError}
   */
  async handle(headers: Record<string, string | string[] | undefined>, body: string): Promise<{ status: number; json: unknown }> {
    throw new Error('not implemented');
  }
}

export type _Refs = [ToolResult];
