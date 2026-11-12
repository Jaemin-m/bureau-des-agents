// server/agents/adapter.ts (SKETCH): THE boundary. Nothing above this file knows a wire format.
// Public surface = these types + `registry.ts` (probeAll, adapterFor). Per-CLI files are not importable from outside server/agents/
// (enforce with an eslint/tsc "paths" rule or a grep in `npm run check`: only agents/registry.ts may import agents/<cli>.ts).
import type { ActKind, AgentKind, Role } from './shared.protocol.ts';
import type { AbsPath, SessionRef } from './conductor.model.ts';

export interface Capabilities {
  /** host can answer tool approvals mid-turn (claude yes; codex exec / gemini -p no: policy is fixed at launch) */
  approvals: boolean;
  /** a message can be injected while a turn runs. v1: false everywhere (unverified for claude); Conductor then queues until turn_end */
  steer: boolean;
  /** one process holds the session across turns (claude yes; exec/-p families are process-per-turn behind the same interface) */
  liveSession: boolean;
  web: boolean;
  /** can mount the office MCP server, i.e. can be the lead. v1: claude only. */
  hostTools: boolean;
}

export interface AdapterProbe { kind: AgentKind; found: boolean; version?: string; path?: string; vendor: string; caps: Capabilities; note?: string }

/** What the CLI needs to know, in office terms. Each adapter maps to its own flags. */
export interface SessionSpec {
  cwd: AbsPath;
  /** read-only extra dirs (e.g. a report folder); claude --add-dir, codex --add-dir, gemini --include-directories */
  readDirs: AbsPath[];
  role: Role;
  /** 'read' = no file writes, no shell that mutates; 'write' = may edit inside cwd */
  access: 'read' | 'write';
  /** office setting 'ask' | 'auto'. Adapters without approvals map 'ask' to the most conservative sandbox and say so in `note`. */
  autonomy: 'ask' | 'auto';
  model?: string;
  systemPrompt: string;
  /** set only for the lead: the office MCP endpoint (per-process token) */
  lead?: { mcpUrl: string };
  resume?: SessionRef;
}

export interface TurnInput { text: string }

/**
 * What an adapter emits, already parsed and CLI-neutral. Mirrors OfficeEvent where possible so projection is trivial,
 * but adds the things only the Conductor should interpret (turn_end, session, exit, approval).
 */
export type WorkerSignal =
  | { k: 'session'; ref: SessionRef }
  | { k: 'think' }
  | { k: 'typing'; text: string }                       // adapter-throttled (120 ms); never logged
  | { k: 'say'; text: string }
  | { k: 'plan'; items: { text: string; status: 'pending' | 'in_progress' | 'completed' }[] }
  | { k: 'act'; id: string; kind: ActKind; tool: string; label: string; detail: string; touched?: string }
  | { k: 'act_done'; id: string; ok: boolean }
  | { k: 'approval'; id: string; tool: string; label: string; detail: string; full: boolean }
  | { k: 'approval_cancelled'; id: string }
  | { k: 'usage'; tokens: number; tools: number }
  | { k: 'turn_end'; outcome: 'ok' | 'error' | 'interrupted'; text: string; error?: string }  // text = last assistant message, handback block still inside (parsed in text.ts)
  | { k: 'exit'; code: number | null; signal: string | null; expected: boolean; stderrTail: string }
  | { k: 'diag'; line: string };                        // unparsable stdout line (explore-clis: gemini/codex banners); capped, logged to a debug ring, not to the mission log

export type Sink = (s: WorkerSignal) => void;

/**
 * The logical session, independent of process residency. `send` works whether or not a process is currently held:
 * turn-per-process adapters spawn `resume`; claude respawns with --resume after a park. So the Conductor never
 * orchestrates processes, it only decides turns. Contract (tested with every adapter against the same fake-CLI conformance suite):
 *   - exactly one `turn_end` per accepted turn, even on crash (outcome 'error') or interrupt ('interrupted');
 *   - after `kill()` no further signal is delivered except one `exit`;
 *   - `send(mode:'steer')` only when caps.steer, else throws (Conductor never does it);
 *   - the Conductor never calls `send(turn)` while a turn is running (queueing lives in Conductor state, single owner).
 */
export interface AgentSession {
  send(turn: TurnInput, mode: 'turn' | 'steer'): void;
  answerApproval(id: string, allow: boolean): void;
  interrupt(): void;
  /** release the process; the session stays resumable. Resolves after the process is gone. */
  park(): Promise<void>;
  kill(): void;
  readonly pid: number | undefined;
}

export interface AgentAdapter {
  readonly kind: AgentKind;
  /** --version + cheap capability detection (never runs a model). Cached by registry; re-probed on demand. */
  probe(): Promise<AdapterProbe>;
  /** Starts the first turn immediately. Honors <KIND>_BIN so the fake-CLI harness (and users with odd installs) can point elsewhere. */
  open(spec: SessionSpec, first: TurnInput, sink: Sink): AgentSession;
}

/** registry.ts: the only importer of the per-CLI modules. */
export function probeAll(): Promise<Record<AgentKind, AdapterProbe>> { throw new Error('not implemented'); }
export function adapterFor(kind: AgentKind): AgentAdapter { throw new Error('not implemented'); }

/** env.ts: one function decides what leaks into a child (C12). Strips API keys unless BUREAU_USE_API_KEY=1; sets BUREAU_DES_AGENTS=1; isolates per-CLI home vars only when asked. */
export function childEnv(kind: AgentKind, base: NodeJS.ProcessEnv, useApiKeys: boolean): NodeJS.ProcessEnv { throw new Error('not implemented'); }
