// codex 어댑터: `codex exec --json`을 턴마다 새 프로세스로 돌린다. 세션은 thread_id로 이어진다(`exec resume <id>`).
// 승인 요청도, 턴 도중 끼어들기도 없다: 샌드박스가 곧 정책이다.
//   - codexArgv: 옵션을 만드는 순수 함수.   - codexMapper: JSONL 한 줄 → WorkerSignal[] 순수 함수.
//   - CodexSession: 프로세스 껍데기(AgentSession). 상주하는 프로세스가 없어서 park는 할 일이 없다.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeAct } from '../../shared/activity.ts';
import type { AdapterProbe, AgentAdapter, AgentSession, Capabilities, SessionSpec, Sink, TurnInput, WorkerSignal } from './adapter.ts';
import { childEnv, useApiKeys } from './env.ts';
import { parseJsonLine, Proc, type ExitInfo } from './lines.ts';

type Json = Record<string, any>;

// 녹화(codex-0.167.1)에 웹 검색 항목이 한 번도 없었다: 확인하지 못한 것은 켜지 않는다
const CAPS: Capabilities = { approvals: false, steer: false, liveSession: false, web: false, hostTools: false };
const NOTE = 'Codex 일꾼은 일하는 도중에 허락을 물을 수 없어요. 샌드박스 안에서만 일하고, 폴더 밖은 건드리지 못해요.';

// ── 설치 찾기 ──

function candidates(): string[] {
  const home = os.homedir();
  const fromPath = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, 'codex'));
  const all = [process.env.CODEX_BIN, ...fromPath, path.join(home, '.local/bin/codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex'];
  return [...new Set(all.filter((x): x is string => !!x))].filter((c) => existsSync(c));
}

function version(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, ['--version'], { timeout: 15000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

async function findCodex(): Promise<{ path: string; version: string } | null> {
  for (const c of candidates()) {
    try {
      const out = (await version(c)).trim();
      return { path: c, version: /\d+\.\d+\.\d+\S*/.exec(out)?.[0] ?? out };
    } catch { /* 다음 후보를 시도한다 */ }
  }
  return null;
}

// ── 옵션 ──

/**
 * 첫 턴은 `exec`, 이어가기는 `exec resume <thread_id>`(`--last`는 쓰지 않는다: 다른 세션을 집을 수 있다).
 * resume에는 `-s`와 `-C`가 없고 샌드박스가 읽기 전용으로 떨어지므로 `-c sandbox_mode`로 다시 정하고, 폴더는 프로세스의 cwd가 정한다.
 * 쓰기는 늘 workspace-write다: autonomy가 'ask'여도 더 보수적일 수 없고, danger-full-access는 쓰지 않는다.
 * `--ignore-user-config`: 사용자의 MCP 서버와 설정이 사무실에 끼어들지 않는다(로그인은 그대로 된다).
 */
export function codexArgv(spec: SessionSpec, threadId?: string): string[] {
  const sandbox = spec.access === 'read' ? 'read-only' : 'workspace-write';
  const model = spec.model ? ['-m', spec.model] : [];
  if (threadId) return ['exec', 'resume', threadId, '--json', '--ignore-user-config', '--skip-git-repo-check', '-c', `sandbox_mode="${sandbox}"`, ...model, '-'];
  return ['exec', '--json', '--ignore-user-config', '--skip-git-repo-check', '-C', spec.cwd, '-s', sandbox, ...model, '-'];
}

/** codex exec에는 시스템 프롬프트 옵션이 없다: 새 스레드의 첫 말 앞에 붙인다. */
export function codexPrompt(spec: SessionSpec, text: string, threadId?: string): string {
  return threadId || !spec.systemPrompt ? text : `${spec.systemPrompt}\n\n---\n\n${text}`;
}

// ── 줄 → 신호 ──

/** `/bin/zsh -lc "…"`로 감싼 명령에서 사람이 쓴 명령만 꺼낸다. */
export function bareCommand(cmd: string): string {
  const m = /^(?:\S*\/)?(?:zsh|bash|sh) -lc ([\s\S]*)$/.exec(cmd.trim());
  if (!m) return cmd.trim();
  const body = m[1];
  const q = body[0];
  if ((q === "'" || q === '"') && body.length >= 2 && body.endsWith(q)) {
    const inner = body.slice(1, -1);
    return q === '"' ? inner.replace(/\\(["\\$`])/g, '$1') : inner;
  }
  return body;
}

const CHANGE_TOOL: Record<string, string> = { add: 'Write', update: 'Edit', delete: 'Edit' };

/**
 * `error`는 재연결 시도처럼 턴을 끝내지 않는 것도 있어서(녹화에 없다) 턴을 끝내는 것은 turn.failed와 turn.completed뿐이다.
 * 프로세스가 그것 없이 죽으면 껍데기가 abort()로 마지막 `error`를 담아 턴을 끝낸다.
 */
export function codexMapper(cwd: string) {
  const started = new Set<string>();
  let acts = 0;
  let lastSaid = '';
  let lastError = '';

  const reset = () => { started.clear(); acts = 0; lastSaid = ''; lastError = ''; };

  function actOf(item: Json): Extract<WorkerSignal, { k: 'act' }> | null {
    const id = String(item.id ?? '');
    switch (item.type) {
      case 'command_execution': return { k: 'act', id, tool: 'Bash', ...describeAct('Bash', { command: bareCommand(String(item.command ?? '')) }) };
      case 'file_change': {
        const change = (Array.isArray(item.changes) ? item.changes[0] : undefined) as Json | undefined;
        const tool = CHANGE_TOOL[String(change?.kind)] ?? 'Edit';
        return { k: 'act', id, tool, ...describeAct(tool, { file_path: String(change?.path ?? '') }) };
      }
      case 'web_search': return { k: 'act', id, tool: 'WebSearch', ...describeAct('WebSearch', { query: item.query }) };
      case 'mcp_tool_call': return { k: 'act', id, tool: `mcp__${item.server}__${item.tool}`, ...describeAct(`mcp__${item.server}__${item.tool}`, {}) };
    }
    return null;
  }

  const okOf = (item: Json) => (typeof item.exit_code === 'number' ? item.exit_code === 0 : item.status === 'completed');

  function item(kind: 'item.started' | 'item.updated' | 'item.completed', it: Json): WorkerSignal[] {
    const id = String(it.id ?? '');
    if (it.type === 'agent_message') {
      if (kind !== 'item.completed' || !String(it.text ?? '').trim()) return [];
      lastSaid = String(it.text);
      return [{ k: 'say', text: lastSaid }];
    }
    if (it.type === 'reasoning') return kind === 'item.completed' ? [{ k: 'think' }] : [];
    if (it.type === 'todo_list') {
      const items = (Array.isArray(it.items) ? it.items : []) as Json[];
      const firstOpen = items.findIndex((t) => !t.completed);
      return [{ k: 'plan', items: items.map((t, i) => ({ text: String(t.text ?? ''), status: t.completed ? 'completed' : i === firstOpen ? 'in_progress' : 'pending' })) }];
    }
    const out: WorkerSignal[] = [];
    if (kind !== 'item.updated' && !started.has(id)) {
      const act = actOf(it);
      if (!act) return [];
      started.add(id);
      acts++;
      out.push(act);
    }
    if (kind === 'item.completed' && started.has(id)) out.push({ k: 'act_done', id, ok: okOf(it) && it.status !== 'failed' });
    return out;
  }

  function feed(m: Json): WorkerSignal[] {
    switch (m.type) {
      case 'thread.started': return [{ k: 'session', ref: { id: String(m.thread_id ?? ''), cwd } }];
      case 'turn.started': return [{ k: 'think' }];
      case 'item.started':
      case 'item.updated':
      case 'item.completed': return item(m.type, (m.item ?? {}) as Json);
      case 'turn.completed': {
        const u = m.usage ?? {};
        const out: WorkerSignal[] = [
          { k: 'usage', tokens: Number(u.input_tokens ?? 0) + Number(u.output_tokens ?? 0), tools: acts },
          { k: 'turn_end', text: lastSaid, ok: true, interrupted: false },
        ];
        reset();
        return out;
      }
      case 'turn.failed': {
        const error = String(m.error?.message ?? (lastError || 'turn.failed'));
        const out: WorkerSignal[] = [{ k: 'turn_end', text: lastSaid, ok: false, interrupted: false, error }];
        reset();
        return out;
      }
      case 'error':
        lastError = String(m.message ?? 'error');
        return [];
    }
    return [];
  }

  /** 턴을 끝내는 줄 없이 프로세스가 끝났다(죽었거나 중단했다): 그 턴을 지금까지 본 것으로 닫는다. */
  function abort(interrupted: boolean): WorkerSignal {
    const end: WorkerSignal = { k: 'turn_end', text: lastSaid, ok: false, interrupted };
    if (!interrupted) end.error = lastError || 'exited';
    reset();
    return end;
  }

  return { feed, abort };
}

// ── 프로세스 껍데기 ──

const MAX_DIAG = 50;

/** 턴 하나 = 프로세스 하나. */
interface TurnRun { proc: Proc; ended: boolean; interrupting: boolean }

class CodexSession implements AgentSession {
  private spec: SessionSpec;
  private bin: string;
  private sink: Sink;
  private mapper: ReturnType<typeof codexMapper>;
  private threadId: string | undefined;
  private run: TurnRun | null = null;
  /** 아직 사라지지 않은 프로세스(끝난 턴의 것이 아직 정리되는 중일 수 있다) */
  private live = new Set<Proc>();
  private killed = false;
  private dead = false;
  private exitSent = false;
  private diags = 0;

  constructor(bin: string, spec: SessionSpec, sink: Sink) {
    this.bin = bin;
    this.spec = spec;
    this.sink = sink;
    this.threadId = spec.resume?.id;
    this.mapper = codexMapper(spec.cwd);
  }

  get alive() { return !this.killed && !this.dead; }
  get pid() { return this.run?.proc.alive ? this.run.proc.pid : undefined; }

  /** 턴을 연다: 프로세스를 띄우고 프롬프트를 stdin으로 준다. */
  start(turn: TurnInput) {
    const text = codexPrompt(this.spec, turn.text, this.threadId);
    const env = childEnv('codex', process.env, useApiKeys());
    const run: TurnRun = { ended: false, interrupting: false, proc: undefined as unknown as Proc };
    run.proc = new Proc({ bin: this.bin, args: codexArgv(this.spec, this.threadId), env, cwd: this.spec.cwd }, (line) => this.onLine(run, line), (e) => this.onExit(run, e));
    this.live.add(run.proc);
    this.run = run;
    this.spec.tap?.raw('stdin', text);
    run.proc.end(text);
  }

  private emit(run: TurnRun, s: WorkerSignal) {
    if (s.k === 'session') this.threadId = s.ref.id;
    if (s.k === 'turn_end') run.ended = true;
    this.sink(s);
  }

  private onLine(run: TurnRun, line: string) {
    this.spec.tap?.raw('stdout', line);
    if (this.killed || run.ended || run.interrupting) return;
    const m = parseJsonLine(line);
    if (!m) { if (line.trim() && this.diags++ < MAX_DIAG) this.sink({ k: 'diag', line: line.slice(0, 500) }); return; }
    for (const s of this.mapper.feed(m)) this.emit(run, s);
  }

  private onExit(run: TurnRun, e: ExitInfo) {
    this.live.delete(run.proc);
    if (this.killed) { if (this.live.size === 0) this.sendExit(e); return; }
    if (run.interrupting) { this.emit(run, this.mapper.abort(true)); return; }
    if (run.ended) return;
    // 턴이 끝나기 전에 프로세스가 사라졌다. 세션은 끝난 것으로 본다: 이어서 하려면 다시 연다
    this.dead = true;
    this.emit(run, this.mapper.abort(false));
    this.sendExit(e);
  }

  private sendExit(e: ExitInfo) {
    if (this.exitSent) return;
    this.exitSent = true;
    this.sink({ k: 'exit', code: e.code, signal: e.signal, expected: this.killed, stderrTail: e.stderrTail });
  }

  send(turn: TurnInput, mode: 'turn' | 'steer') {
    if (mode === 'steer') throw new Error('codex 어댑터는 턴 도중에 끼어들 수 없어요');
    if (!this.alive) throw new Error('세션이 이미 끝났어요. 이어서 하려면 세션을 다시 열어 주세요');
    if (this.run && !this.run.ended) throw new Error('앞의 턴이 아직 끝나지 않았어요');
    this.start(turn);
  }

  answerApproval() { /* codex는 허락을 묻지 않는다 */ }

  interrupt() {
    const run = this.run;
    if (!run || run.ended || run.interrupting || this.killed) return;
    // turn_end는 프로세스 그룹이 사라진 뒤에 낸다: 그 전에 다음 턴이 시작되어 겹치지 않도록
    run.interrupting = true;
    run.proc.kill();
  }

  park() { return Promise.resolve(); }

  kill() {
    if (this.killed) return;
    this.killed = true;
    if (this.live.size === 0) { queueMicrotask(() => this.sendExit({ code: null, signal: null, stderrTail: '' })); return; }
    for (const p of this.live) p.kill();
  }
}

export const codexAdapter: AgentAdapter = {
  kind: 'codex',

  async probe(): Promise<AdapterProbe> {
    const bin = await findCodex();
    return { kind: 'codex', found: !!bin, version: bin?.version, path: bin?.path, vendor: 'OpenAI', caps: CAPS, note: NOTE };
  },

  open(spec: SessionSpec, first: TurnInput, sink: Sink): AgentSession {
    const bin = candidates()[0];
    if (!bin) throw new Error('이 컴퓨터에서 Codex를 찾을 수 없어요.');
    const session = new CodexSession(bin, spec, sink);
    session.start(first);
    return session;
  },
};
