// claude 어댑터: `claude -p`를 stream-json으로 돌린다. 프로세스 하나가 여러 턴에 걸쳐 세션을 쥐고 있고,
// 턴은 `result`로 끝난다(턴마다 `init`이 다시 온다). 도구 허락은 `can_use_tool` 요청과 답으로 오간다.
//   - claudeArgv: 옵션을 만드는 순수 함수.   - claudeMapper: stream-json 한 줄 → WorkerSignal[] 순수 함수.
//   - ClaudeSession: 프로세스 껍데기(AgentSession).
//   - 맨 아래 「레거시 팀장」: 팀장이 서브에이전트(--agents)를 부리는 지금의 방식을 사무실 이벤트로 옮긴다. 컨덕터로 넘어가면 통째로 지운다.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CLAUDE_TOOLS, describeAct, MUTATING_POWERS, NAMES, permissionText, roleOfType, ROLES, cut } from '../../shared/activity.ts';
import type { OfficeEvent, PlanItem, Quota, Role } from '../../shared/protocol.ts';
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

export function claudeArgv(spec: SessionSpec, legacyTeam?: string): string[] {
  const tools = spec.access === 'read' ? spec.powers.tools.filter((t) => !MUTATING_TOOLS.has(t)) : [...spec.powers.tools];
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--permission-mode', spec.autonomy === 'ask' ? 'acceptEdits' : 'auto',
    // 제한 모드: 목록에 있는 도구만 존재하고, 파일 도구는 폴더 안에 머문다.
    // 사용자의 개인 설정이나 개인 에이전트도 사무실에 끼어들지 않는다
    '--restricted', '--tools', tools.join(',')];
  if (legacyTeam !== undefined) args.push('--agents', legacyTeam);
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
        if (m.subtype === 'init') out.push({ k: 'session', ref: { id: String(m.session_id ?? ''), cwd }, model: String(m.model ?? '') });
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
            if (name === 'TodoWrite') {
              const todos = Array.isArray(input.todos) ? (input.todos as Json[]) : [];
              out.push({ k: 'plan', items: todos.map((t) => ({
                text: cut(t.content ?? t.activeForm ?? '', 90),
                status: t.status === 'completed' ? 'completed' : t.status === 'in_progress' ? 'in_progress' : 'pending',
              })) });
            } else {
              out.push({ k: 'act', id: String(c.id), tool: name, ...describeAct(name, input) });
            }
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
function start(spec: SessionSpec, first: TurnInput, h: ShellHandlers, legacyTeam?: string): ClaudeSession {
  const bin = candidates()[0];
  if (!bin) throw new Error('이 컴퓨터에서 Claude Code를 찾을 수 없어요.');
  const env = childEnv('claude', process.env, useApiKeys());
  if (legacyTeam !== undefined) {
    // 사무실 팀만 부를 수 있다(Claude Code의 범용 에이전트는 안 된다)
    env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS = '1';
    // 팀원은 직접 다른 에이전트를 부르지 않는다. 그건 팀장의 일이다
    env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = '1';
    // 팀은 포그라운드에서 일한다: 팀장은 보고서를 기다렸다가 결과물을 합친다
    env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
  }
  return new ClaudeSession({ bin, args: claudeArgv(spec, legacyTeam), env, cwd: spec.cwd }, spec.tap, first, h);
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

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 레거시 팀장. 팀장(맥스) 하나가 Claude Code의 서브에이전트를 부려 일하는 지금의 방식이다.
// 서브에이전트의 모든 일은 팀장의 스트림에 섞여 오고(parent_tool_use_id), 사무실은 그것을 보고 팀원이 오고 가는 것을 짐작한다.
// 일꾼마다 프로세스를 두는 컨덕터로 넘어가면 이 아래는 통째로 지운다. 위의 어떤 것도 이 아래에 기대지 않는다.
// ═══════════════════════════════════════════════════════════════════════════════════════════════

export interface TurnResult { ok: boolean; text: string; ms: number; subtype: string }

/**
 * Claude Code가 하는 말을 사무실 이벤트로 바꾼다.
 * `who`는 “chef”(메인 에이전트)이거나, 팀원을 부른 Agent 호출의 식별자다
 * (그 팀원의 모든 메시지의 parent_tool_use_id에 들어 있다).
 */
export class LegacyTranslator {
  private whoOfTool = new Map<string, string>();      // 도구 호출 → 누가 했는지
  private agentOfTask = new Map<string, string>();    // task_id → 팀원
  private reported = new Set<string>();
  private typing = new Map<string, string>();         // 에이전트별로 쓰고 있는 글
  private typingSentAt = new Map<string, number>();
  private asking = new Set<string>();                 // 아직 답하지 않은 허락 요청
  /** 지금 있는 팀원(불려 와서 아직 떠나지 않음) */
  readonly present = new Set<string>();
  /** 어떤 파일을 마지막으로 누가 썼는지(폴더 파일의 작성자를 정할 때 쓴다) */
  readonly writers = new Map<string, string>();
  /** Claude Code가 시작되면(init 메시지) 참 */
  started = false;
  sessionId = '';

  private emit: (ev: OfficeEvent) => void;
  private onQuota: (q: Quota) => void;
  private onResult: (r: TurnResult) => void;
  private folder: string;
  /** 이 미션에서 이미 쓴 이름(이어서 할 때도 공유한다) */
  private names: Set<string>;

  constructor(opts: { emit: (ev: OfficeEvent) => void; onQuota: (q: Quota) => void; onResult: (r: TurnResult) => void; folder: string; names: Set<string> }) {
    this.emit = opts.emit;
    this.onQuota = opts.onQuota;
    this.onResult = opts.onResult;
    this.folder = opts.folder;
    this.names = opts.names;
  }

  hasRequest(requestId: string) { return this.asking.has(requestId); }
  forgetRequest(requestId: string) { this.asking.delete(requestId); }
  pendingRequests() { return [...this.asking]; }

  private pickName(role: Role) {
    const name = NAMES[role].find((n) => !this.names.has(n)) ?? `${ROLES[role].label} ${this.names.size + 1}`;
    this.names.add(name);
    return name;
  }

  handle(m: Json) {
    switch (m.type) {
      case 'system': this.system(m); break;
      case 'stream_event': this.stream(m); break;
      case 'assistant': this.assistant(m); break;
      case 'user': this.user(m); break;
      case 'result':
        this.typing.clear();
        this.onResult({ ok: !m.is_error && m.subtype === 'success', text: String(m.result ?? ''), ms: Number(m.duration_ms ?? 0), subtype: String(m.subtype ?? '') });
        break;
      case 'rate_limit_event': {
        const w = m.rate_limit_info?.unifiedWindows ?? {};
        if (w.five_hour) this.onQuota({ fiveHour: Number(w.five_hour.utilization ?? 0), resetsAt: Number(w.five_hour.resetsAt ?? 0) || null });
        break;
      }
      case 'control_request': {
        const r = m.request ?? {};
        if (r.subtype !== 'can_use_tool') break;
        const tool = String(r.tool_name ?? '');
        const input = (r.input ?? {}) as Record<string, unknown>;
        this.asking.add(m.request_id);
        const who = (r.tool_use_id && this.whoOfTool.get(r.tool_use_id)) || 'chef';
        const { label, detail, full } = permissionText(tool, input, this.folder);
        this.emit({ k: 'ask', who, requestId: m.request_id, tool, label, detail, full });
        break;
      }
      case 'control_cancel_request': {
        const id = String(m.request_id ?? '');
        if (this.asking.delete(id)) this.emit({ k: 'ask_done', requestId: id, allow: false, cancelled: true });
        break;
      }
    }
  }

  private system(m: Json) {
    switch (m.subtype) {
      case 'init':
        this.started = true;
        this.sessionId = String(m.session_id ?? '');
        this.emit({ k: 'init', model: String(m.model ?? ''), auth: String(m.apiKeySource ?? '') });
        break;
      case 'task_started':
        if (m.task_id && m.tool_use_id) this.agentOfTask.set(m.task_id, m.tool_use_id);
        break;
      case 'task_notification':
        if (m.tool_use_id && m.status) this.leave(m.tool_use_id, m.status === 'completed', m.usage);
        break;
    }
  }

  private leave(id: string, ok: boolean, usage?: Json) {
    if (!this.present.has(id)) return;
    this.present.delete(id);
    this.emit({ k: 'leave', who: id, ok, tokens: Number(usage?.total_tokens ?? 0), tools: Number(usage?.tool_uses ?? 0), ms: Number(usage?.duration_ms ?? 0) });
  }

  private stream(m: Json) {
    const who: string = m.parent_tool_use_id ?? 'chef';
    const e = m.event ?? {};
    if (e.type === 'content_block_start') {
      const b = e.content_block ?? {};
      if (b.type === 'thinking') this.emit({ k: 'think', who });
      if (b.type === 'text') this.typing.set(who, '');
    } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
      const text = (this.typing.get(who) ?? '') + String(e.delta.text ?? '');
      this.typing.set(who, text);
      const now = Date.now();
      if (now - (this.typingSentAt.get(who) ?? 0) > 120) {
        this.typingSentAt.set(who, now);
        this.emit({ k: 'typing', who, text });
      }
    }
  }

  private assistant(m: Json) {
    const who: string = m.parent_tool_use_id ?? 'chef';
    const content = Array.isArray(m.message?.content) ? m.message.content : [];
    for (const c of content as Json[]) {
      if (c.type === 'text' && String(c.text ?? '').trim()) {
        this.typing.delete(who);
        this.emit({ k: 'say', who, text: String(c.text) });
      } else if (c.type === 'tool_use') {
        const name = String(c.name ?? '');
        const input = (c.input ?? {}) as Record<string, unknown>;
        this.whoOfTool.set(c.id, who);
        if (name === 'Agent' || name === 'Task') {
          const type = String(input.subagent_type ?? '');
          const role = roleOfType(type);
          this.present.add(c.id);
          this.emit({ k: 'hire', id: c.id, role, type, name: this.pickName(role), task: cut(input.description || ROLES[role].label, 48), prompt: cut(input.prompt, 2000) });
        } else if (name === 'SubagentHandback') {
          this.reported.add(who);
          this.emit({ k: 'report', who, text: String(input.message ?? '').slice(0, 20000) });
        } else if (name === 'TodoWrite' && who === 'chef') {
          const todos = Array.isArray(input.todos) ? (input.todos as Json[]) : [];
          const items: PlanItem[] = todos.map((t) => ({
            text: cut(t.content ?? t.activeForm ?? '', 90),
            status: t.status === 'completed' ? 'completed' : t.status === 'in_progress' ? 'in_progress' : 'pending',
          }));
          this.emit({ k: 'plan', items });
        } else {
          const { kind, label, detail } = describeAct(name, input);
          if ((name === 'Write' || name === 'Edit' || name === 'MultiEdit') && typeof input.file_path === 'string') this.writers.set(input.file_path, who);
          this.emit({ k: 'act', who, id: c.id, kind, tool: name, label, detail });
        }
      }
    }
  }

  private user(m: Json) {
    const content = Array.isArray(m.message?.content) ? m.message.content : [];
    for (const c of content as Json[]) {
      if (c.type !== 'tool_result') continue;
      const id = String(c.tool_use_id ?? '');
      const who = this.whoOfTool.get(id);
      if (who === undefined) continue;
      if (this.present.has(id)) {
        // 팀원의 보고서가 팀장에게 돌아온다: 실시간으로 받지 못했다면 여기서 가져온다
        const r = (m.tool_use_result ?? {}) as Json;
        if (!this.reported.has(id)) {
          const text = typeof r.handbackReport?.text === 'string' ? r.handbackReport.text : textOf(c.content);
          if (text.trim()) { this.reported.add(id); this.emit({ k: 'report', who: id, text: text.slice(0, 20000) }); }
        }
        this.leave(id, !c.is_error && r.status !== 'failed', r.usage ?? { total_tokens: r.totalTokens, tool_uses: r.totalToolUseCount, duration_ms: r.totalDurationMs });
        continue;
      }
      this.emit({ k: 'act_done', who, id, ok: !c.is_error });
    }
  }
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: Json) => (c?.type === 'text' ? String(c.text ?? '') : '')).join('\n');
  return '';
}

export interface LegacyLeadHandlers {
  emit: (ev: OfficeEvent) => void;
  onQuota: (q: Quota) => void;
  onResult: (r: TurnResult) => void;
  onExit: (e: ExitInfo & { expected: boolean }) => void;
  /** 이 미션에서 이미 쓴 이름 */
  names: Set<string>;
}

export interface LegacyLead { session: AgentSession; translator: LegacyTranslator }

/** 팀장 세션을 연다: 어댑터와 같은 껍데기에 `--agents` 팀과 레거시 번역기를 붙인다. */
export function openLegacyLead(spec: SessionSpec, first: TurnInput, team: string, h: LegacyLeadHandlers): LegacyLead {
  const translator = new LegacyTranslator({ emit: h.emit, onQuota: h.onQuota, onResult: h.onResult, folder: spec.cwd, names: h.names });
  const session = start(spec, first, { onLine: (m) => translator.handle(m), onExit: h.onExit }, team);
  return { session, translator };
}
