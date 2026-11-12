// server/conductor/text.ts (SKETCH): everything that turns state into prompt text, and model text into structured intent. Pure.
// Agent-facing text is Korean like today's team.ts prompts; user-facing strings (toasts, event text) are 해요체.

/** What a worker may append to the end of its final message. CLI-agnostic: no tool injection needed for codex/gemini. */
export type Handback =
  | { status: 'done'; summary: string; files?: string[] }
  | { status: 'question'; question: string; options?: string[]; audience?: 'lead' | 'user' }
  | { status: 'blocked'; why: string };

/**
 * Parse the LAST fenced block labelled `handback` in the final message. Tolerant on purpose:
 *   - no block, bad JSON, unknown status  => returns { handback: null, text: whole message }  (caller treats as done: the safe default)
 *   - the block is stripped from `text` so the UI never shows raw JSON
 *   - scans only the last 8 KB; caps summary at 4000 chars
 * This is the ONLY place that trusts model prose; everything downstream gets a typed value.
 */
export function parseHandback(finalText: string): { handback: Handback | null; text: string } { throw new Error('not implemented'); }

/** The one text Max receives when something happened. Ids are included so a re-delivered wake (at-least-once) is recognisable. */
export function wakeText(news: readonly { id: string; line: string }[], openQuestions: readonly { id: string; from: string; text: string }[]): string { throw new Error('not implemented'); }

/** Max's system prompt: roles, the five office_* tools, the loop (plan -> end your turn -> you will be woken), Korean-to-user rule, how to choose an agent
 *  (the capability table is GENERATED from adapter probes, never hand-written). */
export function leadPrompt(opts: { rules: string; agents: readonly { kind: string; vendor: string; strengths: string }[]; repo?: { label: string; baseBranch: string } }): string { throw new Error('not implemented'); }

/** Worker system prompt: role, workspace rules (never run git commit/checkout/branch, the office does), and the handback block format. */
export function workerPrompt(opts: { role: string; rules: string; access: 'read' | 'write'; repo: boolean }): string { throw new Error('not implemented'); }
