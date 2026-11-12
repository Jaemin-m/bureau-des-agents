// claude 어댑터: `claude -p`를 stream-json으로 돌린다. 프로세스 하나가 여러 턴에 걸쳐 세션을 쥐고 있고,
// 턴은 `result`로 끝난다(턴마다 `init`이 다시 온다). 도구 허락은 `can_use_tool` 요청과 답으로 오간다.
//   - claudeArgv: 옵션을 만드는 순수 함수.   - claudeMapper: stream-json 한 줄 → WorkerSignal[] 순수 함수.
//   - ClaudeSession: 프로세스 껍데기(AgentSession).
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_TOOLS, describeAct, MUTATING_POWERS, permissionText } from '../../shared/activity.ts';
import type { AdapterProbe, AgentAdapter, AgentSession, Capabilities, RawTap, SessionSpec, Sink, TurnInput, WorkerSignal } from './adapter.ts';
import { childEnv, useApiKeys } from './env.ts';
import { parseJsonLine, Proc, type ExitInfo, type Launch } from './lines.ts';

type Json = Record<string, any>;

const CAPS: Capabilities = { approvals: true, steer: false, liveSession: true, web: true, hostTools: true };

// ── 설치 찾기 ──

export interface ClaudeBinary { path: string; version: string }

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** 실행 파일 `claude`가 있을 만한 곳(터미널 별칭은 거치지 않는다). CLAUDE_BIN이 먼저다. */
function candidates(): string[] {
  const home = os.homedir();
  const fromPath = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, 'claude'));
  const all = [process.env.CLAUDE_BIN, ...fromPath, path.join(home, '.local/bin/claude'), path.join(home, '.claude/local/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  return [...new Set(all.filter((x): x is string => !!x))].filter((c) => existsSync(c));
}

export async function findClaude(): Promise<ClaudeBinary | null> {
  for (const c of candidates()) {
    try {
      const out = await run(c, ['--version']);
      return { path: c, version: out.trim().split(/\s+/)[0] ?? out.trim() };
    } catch { /* 다음 후보를 시도한다 */ }
  }
  return null;
}

// ── 옵션 ──

/** access가 'read'면 빠지는 도구. */
const MUTATING_TOOLS = new Set(CLAUDE_TOOLS.filter((t) => MUTATING_POWERS.includes(t.power)).map((t) => t.tool));

export function claudeArgv(spec: SessionSpec): string[] {
  const tools = spec.access === 'read' ? spec.powers.tools.filter((t) => !MUTATING_TOOLS.has(t)) : [...spec.powers.tools];
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--permission-mode', spec.autonomy === 'ask' ? 'acceptEdits' : 'auto',
    // 제한 모드: 목록에 있는 도구만 존재하고, 파일 도구는 폴더 안에 머문다.
    // 사용자의 개인 설정이나 개인 에이전트도 사무실에 끼어들지 않는다
    '--restricted', '--tools', tools.join(',')];
  args.push('--append-system-prompt', spec.systemPrompt);
  if (spec.model) args.push('--model', spec.model);
  if (spec.resume) args.push('--resume', spec.resume.id);
  if (spec.powers.preapproved.length) args.push('--allowedTools', spec.powers.preapproved.join(','));
  if (spec.mcpConfig) args.push('--mcp-config', spec.mcpConfig);
  if (spec.strictMcp) args.push('--strict-mcp-config');
  // 객관식 질문은 없다: 팀장은 대화 안에서 질문한다
  args.push('--disallowedTools', 'AskUserQuestion');
  return args;
}

// ── 줄 → 신호 ──

/**
 * stream-json 한 줄을 신호로 바꾼다. 서브에이전트는 모른다: 한 프로세스 = 일꾼 하나.
 * `now`는 글 쓰는 중(typing) 신호를 120ms마다 한 번으로 줄이는 데 쓴다.
 */
export function claudeMapper(cwd: string, now: () => number = Date.now) {
  const toolIds = new Set<string>();
  const pending = new Set<string>();
  let typing = '';
  let typedAt = 0;
  let lastSaid = '';
  let acts = 0;

  function feed(m: Json): WorkerSignal[] {
    const out: WorkerSignal[] = [];
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init') out.push({ k: 'session', ref: { id: String(m.session_id ?? ''), cwd }, model: String(m.model ?? ''), auth: String(m.apiKeySource ?? '') });
        break;
      case 'stream_event': {
        const e = m.event ?? {};
        if (e.type === 'content_block_start') {
          const b = e.content_block ?? {};
          if (b.type === 'thinking') out.push({ k: 'think' });
          if (b.type === 'text') typing = '';
        } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          typing += String(e.delta.text ?? '');
          const t = now();
          if (t - typedAt > 120) { typedAt = t; out.push({ k: 'typing', text: typing }); }
        }
        break;
      }
      case 'assistant': {
        const content = Array.isArray(m.message?.content) ? m.message.content : [];
        for (const c of content as Json[]) {
          if (c.type === 'text' && String(c.text ?? '').trim()) {
            typing = '';
            lastSaid = String(c.text);
            out.push({ k: 'say', text: lastSaid });
          } else if (c.type === 'tool_use') {
            const name = String(c.name ?? '');
            const input = (c.input ?? {}) as Record<string, unknown>;
            toolIds.add(c.id);
            acts++;
            out.push({ k: 'act', id: String(c.id), tool: name, ...describeAct(name, input) });
          }
        }
        break;
      }
      case 'user': {
        const content = Array.isArray(m.message?.content) ? m.message.content : [];
        for (const c of content as Json[]) {
          if (c.type !== 'tool_result') continue;
          const id = String(c.tool_use_id ?? '');
          if (toolIds.has(id)) out.push({ k: 'act_done', id, ok: !c.is_error });
        }
        break;
      }
      case 'result': {
        const ok = !m.is_error && m.subtype === 'success';
        const u = m.usage ?? {};
        typing = '';
        out.push({ k: 'usage', tokens: Number(u.input_tokens ?? 0) + Number(u.output_tokens ?? 0), tools: acts });
        const end: WorkerSignal = {
          k: 'turn_end', text: typeof m.result === 'string' && m.result ? m.result : lastSaid, ok,
          interrupted: !!m.is_error && m.terminal_reason === 'aborted_streaming',
        };
        if (!ok) end.error = String(m.subtype ?? 'error');
        out.push(end);
        acts = 0;
        lastSaid = '';
        break;
      }
      case 'rate_limit_event': {
        const w = m.rate_limit_info?.unifiedWindows ?? {};
        if (w.five_hour) out.push({ k: 'quota', fiveHour: Number(w.five_hour.utilization ?? 0), resetsAt: Number(w.five_hour.resetsAt ?? 0) || null });
        break;
      }
      case 'control_request': {
        const r = m.request ?? {};
        if (r.subtype !== 'can_use_tool') break;
        const tool = String(r.tool_name ?? '');
        const id = String(m.request_id);
        pending.add(id);
        out.push({ k: 'approval', id, tool, ...permissionText(tool, (r.input ?? {}) as Record<string, unknown>, cwd) });
        break;
      }
      case 'control_cancel_request': {
        // Claude Code가 요청을 거둬들였다(중단, 턴 종료)
        const id = String(m.request_id ?? '');
        if (pending.delete(id)) out.push({ k: 'approval_cancelled', id });
        break;
      }
    }
    return out;
  }
  return { feed };
}

/** 처리할 줄 모르는 제어 요청이면 그 식별자. 막히지 않도록 껍데기가 바로 거절한다. */
export function unknownControlRequest(m: Json): string | null {
  return m.type === 'control_request' && m.request?.subtype !== 'can_use_tool' ? String(m.request_id ?? '') : null;
}

// ── 프로세스 껍데기 ──

interface ShellHandlers {
  onLine(m: Json): void;
  /** 읽을 수 없는 줄 */
  onDiag?(line: string): void;
  onExit(e: ExitInfo & { expected: boolean }): void;
}

const userMessage = (text: string) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });

class ClaudeSession implements AgentSession {
  private proc: Proc;
  readonly bin: string;
  private tap: RawTap | undefined;
  /** 허락 요청 → 도구 입력(답할 때 그대로 돌려줘야 한다) */
  private inputs = new Map<string, unknown>();
  private expected = false;
  private dead = false;
  /** 받아들였지만 아직 result가 오지 않은 턴 수 */
  openTurns = 0;

  constructor(launch: Launch, tap: RawTap | undefined, first: TurnInput, h: ShellHandlers) {
    this.tap = tap;
    this.bin = launch.bin;
    this.proc = new Proc(launch, (line) => this.onRawLine(line, h), (e) => h.onExit({ ...e, expected: this.expected }));
    this.sendTurn(first);
  }

  get alive() { return this.proc.alive; }
  get pid() { return this.proc.pid; }
  get killed() { return this.dead; }

  private onRawLine(line: string, h: ShellHandlers) {
    this.tap?.raw('stdout', line);
    if (this.dead) return;
    const m = parseJsonLine(line);
    if (!m) { if (line.trim()) h.onDiag?.(line); return; }
    const refuse = unknownControlRequest(m);
    if (refuse !== null) {
      this.write({ type: 'control_response', response: { subtype: 'error', request_id: refuse, error: '에이전트 사무실에서 지원하지 않아요' } });
      return;
    }
    if (m.type === 'control_request') this.inputs.set(String(m.request_id), m.request?.input ?? {});
    else if (m.type === 'control_cancel_request') this.inputs.delete(String(m.request_id ?? ''));
    else if (m.type === 'result') this.openTurns = Math.max(0, this.openTurns - 1);
    h.onLine(m);
  }

  private write(o: Json) {
    if (!this.proc.alive) return false;
    const line = JSON.stringify(o);
    this.tap?.raw('stdin', line);
    return this.proc.write(line);
  }

  private sendTurn(turn: TurnInput) {
    if (this.write(userMessage(turn.text))) this.openTurns++;
  }

  send(turn: TurnInput, mode: 'turn' | 'steer') {
    if (mode === 'steer') throw new Error('claude 어댑터는 턴 도중에 끼어들 수 없어요');
    if (!this.proc.alive) throw new Error('프로세스가 이미 끝났어요. 이어서 하려면 세션을 다시 열어 주세요');
    this.sendTurn(turn);
  }

  answerApproval(id: string, allow: boolean) {
    if (!this.inputs.has(id)) return;
    const input = this.inputs.get(id);
    this.inputs.delete(id);
    this.write({
      type: 'control_response',
      response: {
        subtype: 'success', request_id: id,
        response: allow ? { behavior: 'allow', updatedInput: input ?? {} } : { behavior: 'deny', message: '대표님이 허락하지 않았어요. 다른 방법을 찾거나 대표님에게 물어보세요.' },
      },
    });
  }

  interrupt() {
    this.write({ type: 'control_request', request_id: `stop-${Date.now()}`, request: { subtype: 'interrupt' } });
  }

  park() {
    this.expected = true;
    return this.proc.stop();
  }

  kill() {
    this.expected = true;
    this.dead = true;
    this.proc.kill();
  }
}

/** 프로세스를 띄운다. 첫 턴을 바로 보낸다. */
function start(spec: SessionSpec, first: TurnInput, h: ShellHandlers): ClaudeSession {
  const bin = candidates()[0];
  if (!bin) throw new Error('이 컴퓨터에서 Claude Code를 찾을 수 없어요.');
  return new ClaudeSession({ bin, args: claudeArgv(spec), env: childEnv('claude', process.env, useApiKeys()), cwd: spec.cwd }, spec.tap, first, h);
}

const MAX_DIAG = 50;

export const claudeAdapter: AgentAdapter = {
  kind: 'claude',

  async probe(): Promise<AdapterProbe> {
    const bin = await findClaude();
    return { kind: 'claude', found: !!bin, version: bin?.version, path: bin?.path, vendor: 'Anthropic', caps: CAPS };
  },

  open(spec: SessionSpec, first: TurnInput, sink: Sink): AgentSession {
    const mapper = claudeMapper(spec.cwd);
    let diags = 0;
    const session: ClaudeSession = start(spec, first, {
      onLine: (m) => { for (const s of mapper.feed(m)) sink(s); },
      onDiag: (line) => { if (diags++ < MAX_DIAG) sink({ k: 'diag', line: line.slice(0, 500) }); },
      onExit: (e) => {
        if (!session.killed) {
          for (let i = 0; i < session.openTurns; i++) sink({ k: 'turn_end', text: '', ok: false, interrupted: false, error: 'exited' });
        }
        sink({ k: 'exit', code: e.code, signal: e.signal, expected: e.expected, stderrTail: e.stderrTail });
      },
    });
    return session;
  },
};
