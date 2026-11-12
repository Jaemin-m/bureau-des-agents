// Sketch: two small files.
//
// ── server/agents/rpc.ts (NEW, private to codex.ts and gemini.ts) ──
// JSON-RPC 2.0 over newline-delimited stdio, ~80 lines, no dependency (C28).
// Distinguishes the three inbound shapes by fields: response (id + result|error), request (id + method),
// notification (method, no id). Unparsable lines → onUnparsed (diagnostics ring buffer), never thrown.

export interface RpcPeer {
  call<T>(method: string, params: unknown): Promise<T>;
  notify(method: string, params: unknown): void;
  /** answer a request the other side sent us */
  reply(id: number | string, result: unknown): void;
  replyError(id: number | string, code: number, message: string): void;
}

export function rpcPeer(
  write: (line: string) => void,
  handlers: {
    onNotification(method: string, params: any): void;
    /** every inbound request MUST end in reply/replyError (drivers answer unknown methods at once) */
    onRequest(id: number | string, method: string, params: any): void;
    onUnparsed(line: string): void;
  },
): { peer: RpcPeer; feed(line: string): void; failAll(reason: string): void } {
  throw new Error('not implemented');
}

// ── server/agents/index.ts (NEW, the only public door into server/agents/) ──
// Replaces findClaude(). Record<AgentKind, Driver> makes a missing driver a type error (no hand-synced list).

import type { AgentCliInfo, AgentKind } from '../../shared/protocol.additions.ts';
import type { Driver } from './driver.ts';
export type { Turn, RunnerNote } from './runner.ts';
export { Runner } from './runner.ts';

declare const drivers: Record<AgentKind, Driver>; // = { claude: claudeDriver, codex: codexDriver, gemini: geminiDriver }

export interface Installed { info: AgentCliInfo; driver: Driver; bin?: string }

/** Probe all CLIs in parallel at boot (15 s timeout each). Result is broadcast in hello.agents. */
export async function probeAgents(): Promise<Record<AgentKind, Installed>> {
  throw new Error('not implemented');
}
