// 사무실 팀장 = 화면 없이(“-p”) 실행한 진짜 Claude Code 프로세스. 한 줄에 하나씩 JSON으로 말한다.
//   - 사용자의 메시지를 입력(stream-json)으로 써 준다.
//   - 출력으로 모든 것을 알려 준다: 생각, 글, 도구, 부른 팀원, 보고서.
//   - 허락이 필요하면 요청(control_request)을 보내고 사무실의 답을 기다린다.
// Claude Code에 로그인한 계정, 즉 사용자의 구독으로 돌아간다. 사용량 과금으로 넘어가지 않도록
// 환경에서 API 키를 모두 뺀다.
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { describeAct, NAMES, permissionText, roleOfType, ROLES, cut } from '../shared/activity.ts';
import type { OfficeEvent, PlanItem, Quota, Role } from '../shared/protocol.ts';
import type { WireTap } from './record.ts';

export interface ClaudeBinary { path: string; version: string }

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

/** 실행 파일 `claude`를 찾는다(터미널 별칭은 거치지 않는다). */
export async function findClaude(): Promise<ClaudeBinary | null> {
  const home = os.homedir();
  const fromPath = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, 'claude'));
  const candidates = [process.env.CLAUDE_BIN, ...fromPath, path.join(home, '.local/bin/claude'), path.join(home, '.claude/local/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  for (const c of new Set(candidates.filter((x): x is string => !!x))) {
    if (!existsSync(c)) continue;
    try {
      const out = await run(c, ['--version']);
      return { path: c, version: out.trim().split(/\s+/)[0] ?? out.trim() };
    } catch { /* 다음 후보를 시도한다 */ }
  }
  return null;
}

export interface ProcessOptions {
  bin: string;
  cwd: string;
  permissionMode: string;
  model?: string;
  resume?: string;
  /** 세션의 도구(제한 모드: 이것 말고는 없다) */
  tools: string[];
  /** 허락을 묻지 않는 도구 */
  allowedTools: string[];
  /** 팀(--agents 옵션) */
  agents: string;
  /** 팀장 지시문. Claude Code의 지시문 뒤에 덧붙인다 */
  appendSystemPrompt: string;
  useApiKey: boolean;
  /** 개발용 녹화(BUREAU_RECORD). 없으면 아무것도 남기지 않는다 */
  tap?: WireTap | null;
}

type Json = Record<string, any>;

/** 미션 하나의 Claude Code 프로세스. */
export class ClaudeProcess {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private stderr = '';
  private exited = false;

  private opts: ProcessOptions;
  private onMessage: (m: Json) => void;
  private onExit: (code: number | null, signal: string | null, stderr: string) => void;

  constructor(opts: ProcessOptions, onMessage: (m: Json) => void, onExit: (code: number | null, signal: string | null, stderr: string) => void) {
    this.opts = opts;
    this.onMessage = onMessage;
    this.onExit = onExit;
  }

  get alive() { return !!this.proc && !this.exited; }

  start() {
    const o = this.opts;
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--permission-mode', o.permissionMode,
      // 제한 모드: 목록에 있는 도구만 존재하고, 파일 도구는 미션 폴더 안에 머문다.
      // 사용자의 개인 설정이나 개인 에이전트도 사무실에 끼어들지 않는다
      '--restricted', '--tools', o.tools.join(','),
      '--agents', o.agents,
      '--append-system-prompt', o.appendSystemPrompt];
    if (o.model) args.push('--model', o.model);
    if (o.resume) args.push('--resume', o.resume);
    if (o.allowedTools.length) args.push('--allowedTools', o.allowedTools.join(','));
    // 객관식 질문은 없다: 팀장은 대화 안에서 질문한다
    args.push('--disallowedTools', 'AskUserQuestion');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      BUREAU_DES_AGENTS: '1',
      // 사무실 팀만 부를 수 있다(Claude Code의 범용 에이전트는 안 된다)
      CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1',
      // 팀원은 직접 다른 에이전트를 부르지 않는다. 그건 팀장의 일이다
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1',
      // 팀은 포그라운드에서 일한다: 팀장은 보고서를 기다렸다가 결과물을 합친다
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    };
    if (!o.useApiKey) { delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN; }
    const p = spawn(o.bin, args, { cwd: o.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = p;
    readline.createInterface({ input: p.stdout }).on('line', (line) => {
      o.tap?.raw('stdout', line);
      if (!line.trim()) return;
      let m: Json;
      try { m = JSON.parse(line); } catch { return; }
      this.onMessage(m);
    });
    p.stderr.on('data', (b: Buffer) => { this.stderr = (this.stderr + b.toString()).slice(-4000); });
    const done = (code: number | null, signal: string | null) => {
      if (this.exited) return;
      this.exited = true;
      this.onExit(code, signal, this.stderr);
    };
    // “close”는 출력을 끝까지 읽은 뒤에 온다(“exit”와 다르다)
    p.on('close', (code, signal) => done(code, signal));
    // claude를 실행할 수 없다(삭제됨, 실행 권한 없음…): 오류로 끝난다
    p.on('error', (e) => { this.stderr += String(e); done(1, null); });
    p.stdin.on('error', () => { /* 프로세스가 이미 끝났다: “close”가 처리한다 */ });
  }

  private write(o: Json) {
    if (!this.alive) return false;
    const line = JSON.stringify(o);
    this.opts.tap?.raw('stdin', line);
    this.proc!.stdin.write(line + '\n');
    return true;
  }

  send(text: string) {
    return this.write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });
  }

  answerPermission(requestId: string, allow: boolean, input: unknown) {
    this.write({
      type: 'control_response',
      response: {
        subtype: 'success', request_id: requestId,
        response: allow ? { behavior: 'allow', updatedInput: input ?? {} } : { behavior: 'deny', message: '대표님이 허락하지 않았어요. 다른 방법을 찾거나 대표님에게 물어보세요.' },
      },
    });
  }

  /** 처리할 줄 모르는 제어 요청: 막히지 않도록 바로 답한다. */
  refuseControl(requestId: string) {
    this.write({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: '에이전트 사무실에서 지원하지 않아요' } });
  }

  interrupt() {
    this.write({ type: 'control_request', request_id: `stop-${Date.now()}`, request: { subtype: 'interrupt' } });
  }

  stop() {
    if (!this.alive) return;
    this.proc!.stdin.end();
    const p = this.proc!;
    setTimeout(() => { if (!this.exited) p.kill('SIGTERM'); }, 5000);
  }

  /** 즉시 멈춘다(브리지가 멈출 때). */
  kill() {
    if (this.alive) this.proc!.kill('SIGTERM');
  }
}

export interface TurnResult { ok: boolean; text: string; ms: number; subtype: string }

/**
 * Claude Code가 하는 말을 사무실 이벤트로 바꾼다.
 * `who`는 “chef”(메인 에이전트)이거나, 팀원을 부른 Agent 호출의 식별자다
 * (그 팀원의 모든 메시지의 parent_tool_use_id에 들어 있다).
 */
export class Normalizer {
  private whoOfTool = new Map<string, string>();      // 도구 호출 → 누가 했는지
  private agentOfTask = new Map<string, string>();    // task_id → 팀원
  private reported = new Set<string>();
  private typing = new Map<string, string>();         // 에이전트별로 쓰고 있는 글
  private typingSentAt = new Map<string, number>();
  private pendingInputs = new Map<string, unknown>(); // 허락 요청 → 도구 입력
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

  inputOf(requestId: string) { return this.pendingInputs.get(requestId); }
  forgetRequest(requestId: string) { this.pendingInputs.delete(requestId); }
  hasRequest(requestId: string) { return this.pendingInputs.has(requestId); }
  pendingRequests() { return [...this.pendingInputs.keys()]; }

  private pickName(role: Role) {
    const name = NAMES[role].find((n) => !this.names.has(n)) ?? `${ROLES[role].label} ${this.names.size + 1}`;
    this.names.add(name);
    return name;
  }

  /** 거절해야 할(알 수 없는) 제어 요청의 식별자를 돌려준다. 없으면 null. */
  handle(m: Json): string | null {
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
        if (r.subtype !== 'can_use_tool') return String(m.request_id ?? '');
        const tool = String(r.tool_name ?? '');
        const input = (r.input ?? {}) as Record<string, unknown>;
        this.pendingInputs.set(m.request_id, input);
        const who = (r.tool_use_id && this.whoOfTool.get(r.tool_use_id)) || 'chef';
        const { label, detail, full } = permissionText(tool, input, this.folder);
        this.emit({ k: 'ask', who, requestId: m.request_id, tool, label, detail, full });
        break;
      }
      case 'control_cancel_request': {
        // Claude Code가 요청을 거둬들였다(중단, 턴 종료): 말풍선을 치운다
        const id = String(m.request_id ?? '');
        if (this.pendingInputs.has(id)) {
          this.pendingInputs.delete(id);
          this.emit({ k: 'ask_done', requestId: id, allow: false, cancelled: true });
        }
        break;
      }
    }
    return null;
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
