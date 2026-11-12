// Sketch: server/agents/driver.ts (NEW). The per-CLI adapter boundary.
//
// A Driver knows ONE CLI's wire format and nothing about missions, tasks, workers, ids, or OfficeEvents.
// It turns a LaunchSpec into a live process (Wire) and turns that process's output into Signals.
// Everything above this line speaks Signals; everything below speaks stream-json / JSON-RPC.
// Only server/agents/index.ts and server/agents/runner.ts may import this file (scripts/check-imports.ts enforces).

import type { ActKind, Quota, Role } from '../../shared/protocol.ts';
import type { AgentKind } from '../../shared/protocol.additions.ts';

/** What a role may do, CLI-neutral. Each driver maps it to its own flags (claude --tools, codex sandbox, gemini mode). */
export interface Powers { write: boolean; shell: boolean; web: boolean }

/**
 * Opaque, driver-encoded resume handle ("claude:<uuid>", "codex:<threadId>", "gemini:<sessionId>").
 * Persisted in the server ledger only. Branded so a random string can't be passed by mistake.
 */
export type ResumeToken = string & { readonly __resume: unique symbol };

export interface LaunchSpec {
  /** absolute, already validated by the caller (mission folder or this worker's worktree) */
  cwd: string;
  /** extra readable roots (Max's read lens in repo missions). Never the user's checkout. */
  addDirs: string[];
  role: Role;
  powers: Powers;
  model?: string;
  /** 'ask' = surface more approvals; 'auto' = CLI decides, risky actions still asked. Same meaning as Settings.permission. */
  permission: 'auto' | 'ask';
  /** system/developer instructions (Korean). Drivers without a system channel prepend it to the first prompt. */
  instructions: string;
  /** office MCP endpoint for this one session; token is scoped to (missionId, who) and revoked on exit */
  mcp: { url: string; token: string };
  /** resume this conversation instead of starting fresh */
  resume?: ResumeToken;
  /** extra env (BUREAU_DES_AGENTS=1 …). API keys are stripped by the Runner, not here. */
  env: NodeJS.ProcessEnv;
}

export interface Usage { tokens: number; tools: number; ms: number }

/** Normalized output of any CLI. Ids (`id`) are the CLI's native item ids, unique within one Wire. */
export type Signal =
  /** process is up and the conversation exists; `resume` must be persisted before anything else happens */
  | { s: 'ready'; resume: ResumeToken; model: string; auth: string }
  | { s: 'think' }
  | { s: 'typing'; text: string }
  | { s: 'say'; text: string }
  /** path: absolute file path for write/edit acts (folder-mission attribution); never forwarded to the browser */
  | { s: 'act'; id: string; kind: ActKind; tool: string; label: string; detail: string; path?: string }
  | { s: 'act_done'; id: string; ok: boolean }
  /** a tool-permission request the host must answer (claude can_use_tool, codex requestApproval, gemini request_permission) */
  | { s: 'approval'; id: string; tool: string; label: string; detail: string; full: boolean }
  | { s: 'approval_gone'; id: string }
  /** the plan/todo the CLI keeps for itself (TodoWrite, turn/plan/updated, ACP plan). Display only. */
  | { s: 'todo'; items: { text: string; done: boolean }[] }
  | { s: 'turn_end'; ok: boolean; text: string; usage: Usage; interrupted: boolean }
  | { s: 'quota'; quota: Quota }
  /** resume token rejected (session deleted, cwd changed for gemini). Runner relaunches fresh with a recap. */
  | { s: 'resume_failed' }
  /** a line/frame this driver could not understand; kept in a ring buffer for diagnostics (gotcha 17) */
  | { s: 'unparsed'; line: string }
  /** TEMPORARY (delivery units 2–4 only): today's in-process subagent events, passed through verbatim so the driver
   *  extraction is behaviour-neutral. Deleted in unit 5 when Max stops using the Agent tool. */
  | { s: 'legacy'; ev: import('../../shared/protocol.ts').OfficeEvent };

export type SignalSink = (sig: Signal) => void;

/**
 * One live process. The Runner guarantees call discipline, so drivers stay simple:
 *   - prompt() only when no turn is running (after 'ready' or 'turn_end');
 *   - approve() only for an approval id this Wire emitted and not yet 'approval_gone';
 *   - end() at most once.
 */
export interface Wire {
  prompt(text: string): void;
  approve(id: string, allow: boolean): void;
  /** stop the current turn; the CLI should answer with turn_end{interrupted:true} (Runner kills after 5 s if not) */
  interrupt(): void;
  /** graceful close, SIGTERM after 5 s */
  end(): void;
  /** for the restart reaper */
  readonly pid: number | undefined;
}

export interface Driver {
  readonly kind: AgentKind;
  /** find the binary (BUREAU_<KIND>_BIN override → PATH → known dirs), check version and needed capabilities */
  probe(): Promise<{ found: boolean; bin?: string; version?: string; problem?: string }>;
  /** spawn; exit is reported through onExit exactly once, after all stdout was delivered to sink */
  launch(bin: string, spec: LaunchSpec, sink: SignalSink, onExit: (code: number | null, stderrTail: string) => void): Wire;
}
