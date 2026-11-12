// 가짜 에이전트 CLI 하나. 구독을 쓰지 않고 진짜 어댑터의 프로세스 껍데기를 끝까지 지나가게 한다.
// 이 파일은 두 얼굴이다.
//   - 테스트 쪽: `fakeAgents(scripts)`가 `claude`와 `codex` 실행 파일을 깔고 CLAUDE_BIN, CODEX_BIN을 맞춘다. 받은 입력과 옵션은 `launches(kind)`로 읽는다.
//   - 실행 파일 쪽: 맨 아래 main. 대본(JSON)의 단계를 순서대로 따른다. 어느 CLI인지는 `--as <kind>`로 정한다.
// 대본: 프로세스를 띄울 때마다 대본 하나(launches의 한 칸)를 쓴다. 칸이 `match`(정규식)를 가지면 옵션과 첫 입력에 맞는 칸만 쓴다.
// 이어가기(resume)나 일꾼이 여럿인 시나리오는 칸을 하나씩 더 쓰면 된다. 쓸 칸이 없으면 시끄럽게 실패한다(launch-N/failure.txt, 종료 코드 99).
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeLines, CodexLines, mcpRequest, type Json } from './fake-agent-lines.ts';

export type Kind = 'claude' | 'codex';

interface StepArgs {
  /** 원문 줄(들)을 그대로 내보낸다. 객체는 JSON으로 쓴다. `{{session}}` 같은 자리표시자는 채운다 */
  emit: string | Json | (string | Json)[];
  /** 진짜 시간으로 ms만큼 쉰다 */
  wait: number;
  /** 다음 입력 하나를 받아 검사한다: claude는 사용자 메시지 한 줄의 글, codex는 프롬프트 전체. argv는 옵션을 공백으로 이은 글 */
  expectInput: string | { stdin?: string; argv?: string };
  /** 제어 줄(control_request, control_response)이 모두 n줄이 될 때까지 기다린다 */
  expectControl: number;
  /** 턴을 연다. claude는 init(MCP 서버가 있으면 먼저 연결한다), codex는 thread.started와 turn.started */
  begin: true;
  /** 작업 폴더 안에 파일을 쓴다(진짜 변경). 폴더 밖이면 실패한다 */
  writeFile: { path: string; content: string; append?: boolean };
  /** claude: 도구를 허락 없이 쓰고 결과를 받는다 */
  tool: { name: string; input: Json; result?: string; isError?: boolean };
  /** codex: 명령 실행 항목(started, completed). run은 보이는 명령 그대로 */
  command: { run: string; output?: string; exitCode?: number };
  /** claude: can_use_tool을 보내고 답을 기다린다. 답이 expect와 다르면 실패한다 */
  approval: { tool: string; input: Json; expect: 'allow' | 'deny'; result?: string };
  /** claude: 글을 쓰다가 interrupt를 기다린다. 받으면 녹화처럼 답하고 턴을 중단으로 끝낸다. 프로세스는 산다 */
  interrupt: { partial?: string };
  /** 마지막 답. end가 false가 아니면 턴도 끝낸다(claude result, codex turn.completed) */
  say: { text: string; end?: boolean; chunks?: number; usage?: Json };
  /** 마지막 답에 ```handback 블록을 붙여 턴을 끝낸다 */
  handback: { block: Json; text?: string };
  /** claude 팀장만: --mcp-config의 서버에 진짜 HTTP 호출을 하고 claude가 남기는 줄을 내보낸다 */
  mcp: { tool: string; args?: Json; server?: string; saveAs?: string; expectResult?: string };
  /** 같은 프로세스 그룹에 오래 사는 하위 프로세스를 띄우고 pid를 적는다 */
  child: { pidFile: string };
  /** 하던 말을 flush하고 이 코드로 끝낸다 */
  exit: number;
  /** 턴을 끝내는 줄 없이 SIGKILL로 죽는다 */
  crash: true;
  /** 죽을 때까지 끝나지 않는다 */
  hang: true;
}

export type Step = { [K in keyof StepArgs]: { [P in K]: StepArgs[P] } }[keyof StepArgs];
export interface LaunchScript { steps: Step[]; match?: string; session?: string; thread?: string }
export type ScriptInput = Step[] | { launches: (Step[] | LaunchScript)[] };

/** 첫 입력을 받고 턴을 연다. 대본의 거의 모든 턴이 이렇게 시작한다. */
export const turn = (...steps: Step[]): Step[] => [{ expectInput: {} }, { begin: true }, ...steps];

// ═══════════════ 테스트 쪽 ═══════════════

const SELF = fileURLToPath(import.meta.url);

export interface FakeLaunch {
  index: number;
  argv: string[];
  cwd: string;
  /** claude: 받은 줄 그대로. codex: [프롬프트 전체] */
  stdin: string[];
  failure?: string;
}

export interface FakeAgents {
  dir: string;
  bin: Record<Kind, string>;
  launches(kind: Kind): FakeLaunch[];
  /** 대본이 어긋난 곳(검사 불일치, 쓸 칸 없음)이 있으면 던진다 */
  assertClean(): void;
}

const LAUNCH = /^launch-(\d+)$/;

/** 가짜를 깔고 CLAUDE_BIN, CODEX_BIN을 가리킨다(대본을 준 CLI만). 프로세스를 띄울 때마다 launch-N 폴더에 기록이 남는다. */
export function fakeAgents(scripts: Partial<Record<Kind, ScriptInput>> = {}): FakeAgents {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fake-agent-'));
  const bin = { claude: path.join(dir, 'bin', 'claude'), codex: path.join(dir, 'bin', 'codex') };
  mkdirSync(path.join(dir, 'bin'));
  for (const kind of ['claude', 'codex'] as const) {
    const home = path.join(dir, kind);
    mkdirSync(home);
    const input = scripts[kind];
    const launches: LaunchScript[] = !input ? [] : (Array.isArray(input) ? [input] : input.launches).map((l) => (Array.isArray(l) ? { steps: l } : l));
    writeFileSync(path.join(home, 'script.json'), JSON.stringify({ launches }));
    // 환경변수가 이미 있으면 그것이 이긴다(직접 돌려 볼 때)
    writeFileSync(bin[kind], `#!/bin/sh\nexport FAKE_AGENT_SCRIPT="\${FAKE_AGENT_SCRIPT:-${home}/script.json}" FAKE_AGENT_DIR="\${FAKE_AGENT_DIR:-${home}}"\nexec "${process.execPath}" --disable-warning=ExperimentalWarning "${SELF}" --as ${kind} "$@"\n`);
    chmodSync(bin[kind], 0o755);
  }
  if (scripts.claude) process.env.CLAUDE_BIN = bin.claude;
  if (scripts.codex) process.env.CODEX_BIN = bin.codex;

  const launches = (kind: Kind): FakeLaunch[] => {
    const home = path.join(dir, kind);
    return readdirSync(home).map((n) => LAUNCH.exec(n)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1])).sort((a, b) => a - b).map((index) => {
      const at = path.join(home, `launch-${index}`);
      const meta = JSON.parse(readFileSync(path.join(at, 'argv.json'), 'utf8')) as { argv: string[]; cwd: string };
      const raw = existsSync(path.join(at, 'stdin.txt')) ? readFileSync(path.join(at, 'stdin.txt'), 'utf8') : '';
      const failure = existsSync(path.join(at, 'failure.txt')) ? readFileSync(path.join(at, 'failure.txt'), 'utf8') : undefined;
      return { index, ...meta, stdin: kind === 'claude' ? raw.split('\n').filter(Boolean) : raw ? [raw] : [], failure };
    });
  };
  return {
    dir, bin, launches,
    assertClean() {
      const bad = (['claude', 'codex'] as const).flatMap((k) => launches(k).filter((l) => l.failure).map((l) => `${k} #${l.index}: ${l.failure}`));
      if (bad.length) throw new Error(`가짜 에이전트가 어긋났어요:\n${bad.join('\n')}`);
    },
  };
}

// ═══════════════ 실행 파일 쪽 ═══════════════

class Fail extends Error {}
class Closed extends Error {}

/** stdin을 줄(claude)이나 통글(codex)로 받아 쌓는다. 기다림은 모두 `until`로 한다. */
class Input {
  users: string[] = [];
  controls = 0;
  interrupts: string[] = [];
  responses = new Map<string, Json>();
  prompt = '';
  closed = false;
  private buf = '';
  private wake: (() => void)[] = [];
  private kind: Kind;
  private log: (chunk: string) => void;

  constructor(kind: Kind, log: (chunk: string) => void) {
    this.kind = kind;
    this.log = log;
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d: string) => {
      this.log(d);
      if (this.kind === 'codex') this.prompt += d;
      else this.feed(d);
      this.notify();
    });
    process.stdin.on('end', () => { this.closed = true; this.notify(); });
  }

  private feed(d: string) {
    this.buf += d;
    let n: number;
    while ((n = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, n);
      this.buf = this.buf.slice(n + 1);
      if (!line.trim()) continue;
      let m: Json;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.type === 'user') {
        const c = m.message?.content;
        this.users.push(typeof c === 'string' ? c : String(c?.[0]?.text ?? ''));
      } else if (m.type === 'control_request') {
        this.controls++;
        if (m.request?.subtype === 'interrupt') this.interrupts.push(String(m.request_id));
      } else if (m.type === 'control_response') {
        this.controls++;
        this.responses.set(String(m.response?.request_id), m.response);
      }
    }
  }

  private notify() { const w = this.wake; this.wake = []; for (const f of w) f(); }

  async until(cond: () => boolean) {
    while (!cond()) {
      if (this.closed) throw new Closed();
      await new Promise<void>((r) => this.wake.push(r));
    }
  }

  /** 입력이 끝나야 프롬프트가 다 온 것이다(codex는 stdin을 닫는다) */
  nextText = async (): Promise<string> => {
    if (this.kind === 'codex') {
      await this.until(() => this.closed);
      return this.prompt;
    }
    await this.until(() => this.users.length > 0);
    return this.users.shift()!;
  };

  async peek(): Promise<string> {
    if (this.kind === 'codex') { await this.until(() => this.closed); return this.prompt; }
    await this.until(() => this.users.length > 0);
    return this.users[0];
  }
}

const PLACEHOLDER = /\{\{([\w.]+)\}\}/g;
const fill = (v: unknown, table: (k: string) => string | undefined): unknown => {
  if (typeof v === 'string') return v.replace(PLACEHOLDER, (m, k: string) => table(k) ?? m);
  if (Array.isArray(v)) return v.map((x) => fill(x, table));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, table)]));
  return v;
};

interface McpConn { name: string; url: string; headers: Record<string, string>; ok: boolean; tools: string[]; id: number }

class Run {
  readonly vars = new Map<string, string>();
  readonly claude: ClaudeLines;
  readonly codex: CodexLines;
  readonly cwd: string;
  private mcp = new Map<string, McpConn>();
  private toolCalls = 0;
  private begun = false;

  readonly kind: Kind;
  readonly argv: string[];
  readonly input: Input;
  readonly session: string;
  readonly thread: string;
  readonly index: number;

  constructor(kind: Kind, argv: string[], input: Input, session: string, thread: string, index: number) {
    this.kind = kind;
    this.argv = argv;
    this.input = input;
    this.session = session;
    this.thread = thread;
    this.index = index;
    const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
    this.cwd = kind === 'codex' ? path.resolve(flag('-C') ?? process.cwd()) : process.cwd();
    const tools = (flag('--tools') ?? '').split(',').filter(Boolean);
    this.claude = new ClaudeLines({ session, cwd: this.cwd, model: flag('--model') ?? 'fake-model', permissionMode: flag('--permission-mode') ?? 'default', tools, mcpServers: [] });
    this.codex = new CodexLines(thread);
    const config = flag('--mcp-config');
    if (config) {
      const servers = (JSON.parse(config) as { mcpServers?: Record<string, { url: string; headers?: Record<string, string> }> }).mcpServers ?? {};
      for (const [name, s] of Object.entries(servers)) this.mcp.set(name, { name, url: s.url, headers: s.headers ?? {}, ok: false, tools: [], id: 0 });
    }
  }

  table = (k: string): string | undefined => {
    if (k === 'session') return this.session;
    if (k === 'thread') return this.thread;
    if (k === 'cwd') return this.cwd;
    if (k === 'launch') return String(this.index);
    return k.startsWith('var.') ? this.vars.get(k.slice(4)) : undefined;
  };

  out(lines: string[]) {
    for (const l of lines) process.stdout.write(`${l}\n`);
  }

  only(kind: Kind, step: string) {
    if (this.kind !== kind) throw new Fail(`${step} 단계는 ${kind}에서만 쓸 수 있어요(지금은 ${this.kind})`);
  }

  // ── MCP: claude가 시작할 때 서버에 연결하는 것을 흉내 낸다 ──

  private async rpc(c: McpConn, body: Json): Promise<Json | null> {
    const res = await fetch(c.url, {
      method: 'POST', headers: { ...c.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return text ? (JSON.parse(text) as Json) : null;
  }

  private async connect(c: McpConn) {
    try {
      await this.rpc(c, mcpRequest('initialize', { id: c.id++ }));
      await this.rpc(c, mcpRequest('notifications/initialized'));
      const list = await this.rpc(c, mcpRequest('tools/list', { id: c.id++ }));
      c.tools = ((list?.result?.tools ?? []) as { name: string }[]).map((t) => t.name);
      c.ok = true;
    } catch { c.ok = false; }
  }

  async begin() {
    this.begun = true;
    if (this.kind === 'codex') { this.out([this.codex.threadStarted(), this.codex.turnStarted()]); return; }
    for (const c of this.mcp.values()) if (!c.ok) await this.connect(c);
    const w = this.claude.wire;
    w.mcpServers = [...this.mcp.values()].map((c) => ({ name: c.name, status: c.ok ? 'connected' : 'failed' }));
    w.tools = [...w.tools.filter((t) => !t.startsWith('mcp__')), ...[...this.mcp.values()].flatMap((c) => c.tools.map((t) => `mcp__${c.name}__${t}`))];
    this.claude.turnStart();
    this.out([this.claude.init()]);
  }

  needBegun(step: string) {
    if (!this.begun) throw new Fail(`${step} 단계 앞에 begin이 있어야 해요`);
  }

  async mcpCall(a: StepArgs['mcp']) {
    this.only('claude', 'mcp');
    this.needBegun('mcp');
    const c = a.server ? this.mcp.get(a.server) : [...this.mcp.values()][0];
    if (!c?.ok) throw new Fail(`연결된 MCP 서버가 없어요${a.server ? `: ${a.server}` : ''}`);
    const toolId = `toolu_fake${++this.toolCalls}`;
    const input = a.args ?? {};
    this.out(this.claude.toolOpen(toolId, `mcp__${c.name}__${a.tool}`, input));
    let text: string;
    let isError = false;
    try {
      const res = await this.rpc(c, mcpRequest('tools/call', { id: c.id++, params: { name: a.tool, arguments: input, _meta: { 'claudecode/toolUseId': toolId } } }));
      if (res?.error) { text = String(res.error.message ?? 'error'); isError = true; }
      else {
        text = ((res?.result?.content ?? []) as { type: string; text?: string }[]).filter((x) => x.type === 'text').map((x) => x.text ?? '').join('\n');
        isError = !!res?.result?.isError;
      }
    } catch (e) { text = String(e instanceof Error ? e.message : e); isError = true; }
    this.out(this.claude.toolClose(toolId, text, isError));
    if (a.saveAs) this.vars.set(a.saveAs, text);
    if (a.expectResult && !new RegExp(a.expectResult).test(text)) throw new Fail(`mcp ${a.tool}의 결과가 /${a.expectResult}/와 달라요: ${text}`);
  }

  toolId = () => `toolu_fake${++this.toolCalls}`;
}

const STEPS: { [K in keyof StepArgs]: (r: Run, a: StepArgs[K]) => void | Promise<void> } = {
  emit: (r, a) => r.out((Array.isArray(a) ? a : [a]).map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))),
  wait: (_r, ms) => new Promise((res) => setTimeout(res, ms)),
  async expectInput(r, a) {
    const want = typeof a === 'string' ? { stdin: a } : a;
    const text = await r.input.nextText();
    if (want.stdin !== undefined && !new RegExp(want.stdin).test(text)) throw new Fail(`expectInput: 입력이 /${want.stdin}/와 달라요: ${text.slice(0, 300)}`);
    if (want.argv !== undefined && !new RegExp(want.argv).test(r.argv.join(' '))) throw new Fail(`expectInput: 옵션이 /${want.argv}/와 달라요: ${r.argv.join(' ')}`);
  },
  expectControl: (r, n) => r.input.until(() => r.input.controls >= n),
  begin: (r) => r.begin(),
  writeFile(r, a) {
    const file = path.resolve(r.cwd, a.path);
    if (path.relative(r.cwd, file).startsWith('..') || path.isAbsolute(path.relative(r.cwd, file))) throw new Fail(`writeFile: 작업 폴더 밖이에요: ${a.path}`);
    mkdirSync(path.dirname(file), { recursive: true });
    if (a.append) appendFileSync(file, a.content); else writeFileSync(file, a.content);
  },
  tool(r, a) {
    r.only('claude', 'tool');
    r.needBegun('tool');
    const id = r.toolId();
    r.out([...r.claude.toolOpen(id, a.name, a.input), ...r.claude.toolClose(id, a.result ?? '(fake) ok', a.isError)]);
  },
  command(r, a) {
    r.only('codex', 'command');
    r.needBegun('command');
    r.out(r.codex.command(a.run, a.output ?? '', a.exitCode ?? 0));
  },
  async approval(r, a) {
    r.only('claude', 'approval');
    r.needBegun('approval');
    const id = r.toolId();
    const requestId = `req-fake-${id}`;
    r.out([...r.claude.toolOpen(id, a.tool, a.input), r.claude.ask(requestId, id, a.tool, a.input)]);
    await r.input.until(() => r.input.responses.has(requestId));
    const answer = r.input.responses.get(requestId)!;
    const behavior = String(answer.response?.behavior ?? answer.subtype);
    if (behavior !== a.expect) throw new Fail(`approval ${a.tool}: ${a.expect}를 기대했는데 ${behavior}가 왔어요`);
    const allowed = behavior === 'allow';
    r.out(r.claude.toolClose(id, a.result ?? (allowed ? '(fake) ok' : String(answer.response?.message ?? 'denied')), !allowed));
  },
  async interrupt(r, a) {
    r.only('claude', 'interrupt');
    r.needBegun('interrupt');
    r.out(r.claude.saying(a.partial ?? ''));
    await r.input.until(() => r.input.interrupts.length > 0);
    r.out([r.claude.interruptAck(r.input.interrupts.shift()!), r.claude.interruptNote(), r.claude.aborted()]);
  },
  say(r, a) {
    r.needBegun('say');
    const end = a.end !== false;
    if (r.kind === 'codex') {
      r.out([r.codex.message(a.text), ...(end ? [r.codex.turnCompleted(a.usage)] : [])]);
    } else {
      r.out([...r.claude.say(a.text, a.chunks), ...(end ? [r.claude.result(a.text, a.usage)] : [])]);
    }
  },
  handback: (r, a) => STEPS.say(r, { text: `${a.text ? `${a.text}\n\n` : ''}\`\`\`handback\n${JSON.stringify(a.block)}\n\`\`\`` }),
  mcp: (r, a) => r.mcpCall(a),
  child(_r, a) {
    const c = spawn('sleep', ['30'], { stdio: 'ignore' });
    c.unref();
    writeFileSync(a.pidFile, String(c.pid));
  },
  exit: () => { throw new Fail('unreachable'); },
  crash: () => { throw new Fail('unreachable'); },
  hang: () => new Promise<void>(() => { setInterval(() => {}, 1 << 30); }),
};

const flush = () => new Promise<void>((r) => process.stdout.write('', () => r()));

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--as');
  const kind = args[at + 1] as Kind;
  if (at < 0 || (kind !== 'claude' && kind !== 'codex')) throw new Error('사용법: fake-agent.ts --as claude|codex ...');
  args.splice(at, 2);
  if (args.includes('--version')) { console.log(kind === 'claude' ? '9.9.9 (fake)' : 'codex-cli 9.9.9'); return; }

  const scriptFile = process.env.FAKE_AGENT_SCRIPT;
  if (!scriptFile) throw new Error('FAKE_AGENT_SCRIPT가 없어요');
  const home = process.env.FAKE_AGENT_DIR ?? path.dirname(scriptFile);
  const index = (() => {
    for (let n = 0; ; n++) {
      try { mkdirSync(path.join(home, `launch-${n}`)); return n; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    }
  })();
  const dir = path.join(home, `launch-${index}`);
  writeFileSync(path.join(dir, 'argv.json'), JSON.stringify({ argv: args, cwd: process.cwd() }));

  try {
    const input = new Input(kind, (chunk) => appendFileSync(path.join(dir, 'stdin.txt'), chunk));
    const { launches } = JSON.parse(readFileSync(scriptFile, 'utf8')) as { launches: LaunchScript[] };
    // 칸을 고르려면 첫 입력이 필요하다: match가 하나도 없으면 기다리지 않는다
    const probe = launches.some((l) => l.match !== undefined) ? `${args.join(' ')}\n${await input.peek()}` : '';
    const slot = (() => {
      for (let i = 0; i < launches.length; i++) {
        const m = launches[i].match;
        if (m !== undefined && !new RegExp(m).test(probe)) continue;
        try { mkdirSync(path.join(home, `slot-${i}`)); return i; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      }
      throw new Fail(`launch ${index}에 쓸 대본 칸이 없어요(칸 ${launches.length}개)`);
    })();
    const script = launches[slot];
    const resume = kind === 'claude' ? args[args.indexOf('--resume') + 1] : args[args.indexOf('resume') + 1];
    const hasResume = kind === 'claude' ? args.includes('--resume') : args.includes('resume');
    const id = hasResume ? resume : undefined;
    const run = new Run(kind, args, input, script.session ?? id ?? `fake-session-${index}`, script.thread ?? id ?? `fake-thread-${String(index).padStart(4, '0')}`, index);

    try {
      for (const raw of script.steps) {
        const step = fill(raw, run.table) as Record<string, unknown>;
        const keys = Object.keys(step);
        if (keys.length !== 1 || !(keys[0] in STEPS)) throw new Fail(`알 수 없는 단계예요: ${JSON.stringify(raw).slice(0, 200)}`);
        const key = keys[0] as keyof StepArgs;
        if (key === 'exit') { await flush(); process.exit(step.exit as number); }
        if (key === 'crash') { await flush(); process.kill(process.pid, 'SIGKILL'); await new Promise(() => {}); }
        await (STEPS[key] as (r: Run, a: unknown) => void | Promise<void>)(run, step[key]);
      }
      // claude는 입력이 닫힐 때까지 산다(여러 턴을 쥐는 프로세스). codex는 턴 하나로 끝난다
      if (kind === 'claude') await input.until(() => false);
    } catch (e) {
      if (!(e instanceof Closed)) throw e;
    }
    await flush();
    process.exit(0);
  } catch (e) {
    if (e instanceof Closed) { await flush(); process.exit(0); }
    const why = e instanceof Error ? e.message : String(e);
    writeFileSync(path.join(dir, 'failure.txt'), why);
    process.stderr.write(`fake-agent: ${why}\n`);
    await flush();
    process.exit(99);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main().catch((e) => { process.stderr.write(`fake-agent: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(99); });
}
