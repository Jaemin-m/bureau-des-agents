// 에이전트 CLI(claude, codex, gemini)의 진짜 출력을 녹화해 tests/fixtures/<cli>-<버전>/<시나리오>.raw.jsonl에 남긴다.
//   node scripts/record-cli.ts                  실행할 것과 비용 경고만 보여 주고, yes를 입력하면 전부 돌린다
//   node scripts/record-cli.ts --yes            물어보지 않고 돌린다
//   node scripts/record-cli.ts --only claude    claude만(또는 codex, gemini, claude:interrupt 처럼 시나리오 하나만. 쉼표로 여러 개)
// 각 줄은 server/record.ts와 같은 모양이다: {"dir":"stdout"|"stdin"|"stderr","line":"<원문 한 줄>"}  오간 순서대로.
// 시나리오마다 <시나리오>.meta.json(명령, 종료 상태, 관찰한 것)이 함께 남는다.
// 쓰기 전에 모든 줄을 지운다: 임시 폴더, 홈 폴더, 사용자 이름, 이메일, 토큰처럼 생긴 문자열은 고정된 자리표시자로 바뀐다.
// 비용: 모델을 실제로 호출한다(구독 사용량). 한 줄짜리 요청과 가장 싼 모델만 쓰지만 공짜는 아니다.
// 사용자 설정은 건드리지 않는다: mcp add, 로그인, 로그아웃은 하지 않는다. 로그인이 안 된 CLI는 기록만 하고 넘어간다.
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { findClaude } from '../server/agents/claude.ts';
import type { MissionInfo } from '../shared/protocol.ts';
import { spawnOffice } from '../tests/support/office-process.ts';

type Json = Record<string, any>;

const ROOT = path.resolve(import.meta.dirname, '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures');

// ── MCP 샌드박스 서버(claude가 office MCP를 붙일 수 있는지 시험한다) ──
const PONG = 'PONG-7731';

function mcpRpc(msg: Json): Json | null {
  const id = msg.id;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  if (id === undefined) return null; // 알림
  switch (msg.method) {
    case 'initialize':
      return ok({ protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'office-probe', version: '0.0.1' } });
    case 'ping': return ok({});
    case 'tools/list':
      return ok({ tools: [{ name: 'office_ping', description: 'Returns a pong string. Use it to check that the office link works.', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } }] });
    case 'tools/call':
      if (msg.params?.name !== 'office_ping') return { jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool' } };
      return ok({ content: [{ type: 'text', text: `${PONG}:${String(msg.params?.arguments?.message ?? '')}` }] });
    default: return { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } };
  }
}

/** 표준입출력 MCP 서버(줄 단위 JSON). `node scripts/record-cli.ts --mcp-stdio-shim`으로 뜬다. */
function runStdioShim() {
  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    let msg: Json;
    try { msg = JSON.parse(line); } catch { return; }
    const res = mcpRpc(msg);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  });
}

interface McpHttp { port: number; token: string; log: Array<{ dir: 'req' | 'res'; line: string }>; close(): void }

async function startMcpHttp(): Promise<McpHttp> {
  const token = randomBytes(16).toString('hex');
  const log: McpHttp['log'] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const authOk = req.headers.authorization === `Bearer ${token}`;
      log.push({ dir: 'req', line: JSON.stringify({ method: req.method, url: req.url, auth: authOk ? 'bearer-ok' : req.headers.authorization ? 'bearer-wrong' : 'missing', accept: req.headers.accept, contentType: req.headers['content-type'], body: body ? safeParse(body) : undefined }) });
      const reply = (status: number, payload?: unknown) => {
        const text = payload === undefined ? '' : JSON.stringify(payload);
        log.push({ dir: 'res', line: JSON.stringify({ status, body: payload }) });
        res.writeHead(status, payload === undefined ? {} : { 'content-type': 'application/json' });
        res.end(text);
      };
      if (!authOk) return reply(401, { error: 'unauthorized' });
      if (req.method !== 'POST') return reply(405);
      const msg = safeParse(body);
      if (Array.isArray(msg)) {
        const out = msg.map((m) => mcpRpc(m)).filter(Boolean);
        return out.length ? reply(200, out) : reply(202);
      }
      const out = msg && typeof msg === 'object' ? mcpRpc(msg as Json) : null;
      return out ? reply(200, out) : reply(202);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return { port, token, log, close: () => server.close() };
}

function safeParse(s: string): unknown { try { return JSON.parse(s); } catch { return s; } }

// ── 지우기(scrub) ──
function gitValue(key: string) {
  try { return execFileSync('git', ['config', '--get', key], { encoding: 'utf8' }).trim(); } catch { return ''; }
}

const slug = (p: string) => p.replace(/[/.]/g, '-');

function makeScrub(pairs: Array<[string, string]> = []) {
  const home = os.homedir();
  const tmp = os.tmpdir().replace(/\/$/, '');
  const tmpReal = realpathSync(tmp);
  const literal: Array<[string, string]> = [
    ...pairs,
    [tmpReal, '<TMP>'], [tmp, '<TMP>'], [slug(tmpReal), '<TMP-SLUG>'], [slug(tmp), '<TMP-SLUG>'],
    [slug(home), '<HOME-SLUG>'], [home, '<HOME>'],
  ];
  for (const [a, b] of [...literal]) literal.push([slug(a), b === '<HOME>' ? '<HOME-SLUG>' : b]);
  literal.sort((a, b) => b[0].length - a[0].length);
  const names = new Set([os.userInfo().username, process.env.USER, process.env.LOGNAME, gitValue('user.name')].filter((x): x is string => !!x && x.length >= 3));
  const emails = [gitValue('user.email')].filter(Boolean);
  const patterns: Array<[RegExp, string]> = [
    [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<EMAIL>'],
    [/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, '<TOKEN>'],
    [/\bAIza[0-9A-Za-z_-]{30,}/g, '<TOKEN>'],
    [/\bya29\.[0-9A-Za-z_-]{20,}/g, '<TOKEN>'],
    [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '<TOKEN>'],
    [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '<TOKEN>'],
    [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/g, '$1<TOKEN>'],
    [/127\.0\.0\.1:\d{2,5}/g, '127.0.0.1:<PORT>'],
  ];
  return (text: string) => {
    let s = text;
    for (const e of emails) s = s.split(e).join('<EMAIL>');
    for (const [a, b] of literal) if (a) s = s.split(a).join(b);
    for (const [re, b] of patterns) s = s.replace(re, b);
    for (const n of names) s = s.split(n).join('<USER>');
    return s;
  };
}

// ── 녹화 ──
interface RawLine { dir: string; line: string }

/**
 * claude가 보내는 줄에서 사용자 개인 환경이 실린 값을 비운다: 설치된 스킬, 슬래시 명령, 플러그인 목록(제한 모드에서도 나온다)과 자격 증명 만료 시각.
 * 레거시 번역기는 이 값들을 읽지 않는다.
 */
function redactClaudeLine(rawLine: string): string {
  // 생각 블록의 서명은 알아볼 수 없는 긴 암호문이다
  const line = rawLine.replace(/("signature":")[A-Za-z0-9+/=_-]{40,}(")/g, '$1<SIGNATURE>$2');
  let m: Json;
  try { m = JSON.parse(line); } catch { return line; }
  if (!m || typeof m !== 'object') return line;
  if (m.type === 'system' && m.subtype === 'init') {
    for (const k of ['slash_commands', 'skills', 'plugins']) if (k in m) m[k] = [];
    // 사용자의 claude.ai 커넥터(두 번째 턴부터 제한 모드에서도 붙는다): 이름은 지우고 개수와 상태는 남긴다
    if (Array.isArray(m.mcp_servers)) m.mcp_servers = m.mcp_servers.map((x: Json, i: number) => (x?.source === 'claudeai' ? { ...x, name: `claude.ai connector-${i}` } : x));
    if (Array.isArray(m.tools)) m.tools = m.tools.map((t: unknown, i: number) => (typeof t === 'string' && t.startsWith('mcp__claude_ai_') ? `mcp__claude_ai_connector__tool-${i}` : t));
  }
  else if (m.type === 'system' && m.subtype === 'commands_changed') m.commands = [];
  else if (m.type === 'result' && 'credential_expires_at' in m) m.credential_expires_at = '<REDACTED>';
  else return line;
  return JSON.stringify(m);
}

/**
 * 한 블록의 델타(글, 도구 입력, 생각)는 아무 데서나 끊긴다. 경로가 두 조각에 걸치면 조각마다 지우는 방식으로는 못 지운다.
 * 블록별로 이어 붙여 지운 뒤, 같은 개수의 델타로 다시 나눈다. 지울 것이 없는 블록은 그대로 둔다.
 */
function regroupDeltas(lines: RawLine[], scrub: (s: string) => string): RawLine[] {
  const parsed = lines.map((l) => { if (l.dir !== 'stdout') return null; try { return JSON.parse(l.line) as Json; } catch { return null; } });
  const field = (d: Json) => (d?.type === 'text_delta' ? 'text' : d?.type === 'input_json_delta' ? 'partial_json' : d?.type === 'thinking_delta' ? 'thinking' : null);
  const groups = new Map<string, number[]>();
  parsed.forEach((m, i) => {
    if (m?.type !== 'stream_event' || m.event?.type !== 'content_block_delta' || !field(m.event.delta)) return;
    const key = `${m.parent_tool_use_id ?? ''}|${m.event.index}|${m.event.delta.type}|${m.api_message_id ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), i]);
  });
  const out = lines.map((l) => ({ ...l }));
  for (const idxs of groups.values()) {
    const f = field(parsed[idxs[0]]!.event.delta)!;
    const joined = idxs.map((i) => String(parsed[i]!.event.delta[f] ?? '')).join('');
    const clean = scrub(joined);
    if (clean === joined) continue;
    const n = idxs.length;
    let from = 0;
    idxs.forEach((i, k) => {
      let to = k === n - 1 ? clean.length : Math.round(((k + 1) * clean.length) / n);
      const c = clean.charCodeAt(to - 1);
      if (to < clean.length && c >= 0xd800 && c <= 0xdbff) to++;
      const m = parsed[i]!;
      m.event.delta[f] = clean.slice(from, to);
      out[i].line = JSON.stringify(m);
      from = to;
    });
  }
  return out;
}

class Recorder {
  readonly file: string;
  private scrub: (s: string) => string;
  private redact: (line: string) => string;
  constructor(file: string, scrub: (s: string) => string, redact: (line: string) => string = (l) => l) {
    this.file = file;
    this.scrub = scrub;
    this.redact = redact;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, '');
  }
  add(dir: string, line: string) {
    const kept = dir === 'stdout' ? this.redact(line) : line;
    appendFileSync(this.file, JSON.stringify({ dir, line: this.scrub(kept) }) + '\n');
  }
  /** 끝난 뒤 한 번: 조각난 델타를 다시 지운다. */
  finalize() {
    const lines = readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as RawLine);
    const fixed = regroupDeltas(lines, this.scrub);
    writeFileSync(this.file, fixed.map((l) => JSON.stringify(l)).join('\n') + (fixed.length ? '\n' : ''));
  }
}

interface Exit { code: number | null; signal: string | null }

/** 프로세스 하나와 오가는 줄. 받은 줄은 모두 쌓아 두고, 조건이 될 때까지 기다릴 수 있다. */
class Wire {
  readonly msgs: Json[] = [];
  readonly times: number[] = [];
  stderr = '';
  exit: Exit | null = null;
  readonly t0 = Date.now();
  onMessage: ((m: Json) => void) | null = null;
  private child: ChildProcessWithoutNullStreams;
  private rec: Recorder;
  private waiters = new Set<() => void>();
  readonly closed: Promise<Exit>;

  constructor(o: { cmd: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; rec: Recorder; timeoutMs?: number }) {
    this.rec = o.rec;
    this.child = spawn(o.cmd, o.args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] });
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      this.rec.add('stdout', line);
      if (!line.trim()) return;
      let m: Json;
      try { m = JSON.parse(line); } catch { m = { type: '(json이 아닌 줄)', text: line }; }
      this.msgs.push(m);
      this.times.push(Date.now() - this.t0);
      this.onMessage?.(m);
      this.wake();
    });
    readline.createInterface({ input: this.child.stderr }).on('line', (line) => {
      this.stderr = (this.stderr + line + '\n').slice(-4000);
      this.rec.add('stderr', line);
    });
    this.child.stdin.on('error', () => { /* 이미 끝난 프로세스 */ });
    this.closed = new Promise((resolve) => {
      this.child.on('error', (e) => { this.stderr += String(e); this.exit = { code: 1, signal: null }; resolve(this.exit); this.wake(); });
      this.child.on('close', (code, signal) => { this.exit = { code, signal }; resolve(this.exit); this.wake(); });
    });
    const timer = setTimeout(() => { if (!this.exit) { this.stderr += '\n(녹화 스크립트의 제한 시간이 지나 종료했다)'; this.child.kill('SIGKILL'); } }, o.timeoutMs ?? 150_000);
    void this.closed.then(() => clearTimeout(timer));
  }

  private wake() { for (const w of [...this.waiters]) w(); }

  send(o: Json | string) {
    const line = typeof o === 'string' ? o : JSON.stringify(o);
    this.rec.add('stdin', line);
    this.child.stdin.write(line + '\n');
  }
  endStdin() { this.child.stdin.end(); }
  kill(signal: NodeJS.Signals = 'SIGTERM') { this.child.kill(signal); }

  /** 조건이 참이 되면 true, 프로세스가 끝나거나 시간이 지나면 false(끝난 뒤에도 조건을 한 번 더 본다). */
  until(pred: () => boolean, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (pred()) return resolve(true);
      const done = (v: boolean) => { clearTimeout(timer); this.waiters.delete(check); resolve(v); };
      const check = () => { if (pred()) done(true); else if (this.exit) done(false); };
      const timer = setTimeout(() => done(pred()), ms);
      this.waiters.add(check);
    });
  }

  async wait(ms: number) { await Promise.race([this.closed, new Promise((r) => setTimeout(r, ms))]); return this.exit; }
  /** stdin을 닫고 끝나길 기다린다. 안 끝나면 SIGTERM, 그래도 안 끝나면 SIGKILL. */
  async finish(graceMs = 8000): Promise<Exit> {
    this.endStdin();
    if (!(await this.wait(graceMs))) { this.kill('SIGTERM'); if (!(await this.wait(4000))) this.kill('SIGKILL'); }
    return this.closed;
  }
  get ms() { return Date.now() - this.t0; }
}

function histogram(msgs: Json[], key: (m: Json) => string) {
  const h: Record<string, number> = {};
  for (const m of msgs) { const k = key(m); h[k] = (h[k] ?? 0) + 1; }
  return h;
}

// ── 공통 ──
interface Ctx {
  scratch: string;
  versions: Record<string, string>;
  summary: Array<{ cli: string; scenario: string; note: string }>;
  recorders: Recorder[];
  geminiAuth?: boolean;
}

function workdir(ctx: Ctx, name: string) {
  const d = realpathSync(mkdtempSync(path.join(ctx.scratch, `${name}-`)));
  return d;
}

function open(ctx: Ctx, cli: string, scenario: string, work: string, extra: Array<[string, string]> = [], suffix = 'raw.jsonl') {
  const scrub = makeScrub([[work, `<TMP>/${cli}-${scenario}`], ...extra]);
  const dir = path.join(FIXTURES, `${cli}-${ctx.versions[cli]}`);
  const rec = new Recorder(path.join(dir, `${scenario}.${suffix}`), scrub, cli === 'claude' ? redactClaudeLine : undefined);
  ctx.recorders.push(rec);
  return { rec, scrub, dir };
}

function saveMeta(ctx: Ctx, cli: string, scenario: string, scrub: (s: string) => string, dir: string, meta: Json) {
  const text = scrub(JSON.stringify(meta, null, 2));
  writeFileSync(path.join(dir, `${scenario}.meta.json`), text + '\n');
  const note = String(meta.note ?? '');
  ctx.summary.push({ cli, scenario, note });
  console.log(`  [${cli}:${scenario}] ${note}`);
}

const userMsg = (text: string) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // 이 스크립트가 Claude Code 안에서 돌아도 중첩 세션처럼 굴지 않도록, 터미널에서 돌린 것과 같은 환경으로 만든다
  for (const k of Object.keys(env)) if (/^(CLAUDE|ANTHROPIC)/.test(k)) delete env[k];
  return env;
}

// ── claude ──
interface ClaudeOpts { permissionMode: string; tools: string[]; allowedTools?: string[]; mcpConfig?: string }

/** server/agents/claude.ts의 claudeArgv와 같은 옵션(팀과 지시문은 시험에 맞게 줄였고 모델은 haiku). */
function claudeArgs(o: ClaudeOpts) {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--permission-mode', o.permissionMode,
    '--restricted', '--tools', o.tools.join(','),
    '--append-system-prompt', 'You are a test probe. Be extremely brief.',
    '--model', 'haiku'];
  if (o.allowedTools?.length) args.push('--allowedTools', o.allowedTools.join(','));
  if (o.mcpConfig) args.push('--mcp-config', o.mcpConfig, '--strict-mcp-config');
  args.push('--disallowedTools', 'AskUserQuestion');
  return args;
}

function claudeEnv(): NodeJS.ProcessEnv {
  return {
    ...cleanEnv(),
    BUREAU_DES_AGENTS: '1',
    CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: '1',
    CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
  };
}

const isResult = (m: Json) => m.type === 'result';
const textDeltas = (w: Wire) => w.msgs.filter((m) => m.type === 'stream_event' && m.event?.type === 'content_block_delta' && m.event?.delta?.type === 'text_delta');
const results = (w: Wire) => w.msgs.filter(isResult);
const resultSummary = (m: Json) => ({ subtype: m.subtype, is_error: m.is_error, num_turns: m.num_turns, result: typeof m.result === 'string' ? m.result.slice(0, 200) : m.result, terminal_reason: m.terminal_reason, stop_reason: m.stop_reason });

function startClaude(ctx: Ctx, scenario: string, o: ClaudeOpts, extra: Array<[string, string]> = []) {
  const work = workdir(ctx, `claude-${scenario}`);
  const { rec, scrub, dir } = open(ctx, 'claude', scenario, work, extra);
  const args = claudeArgs(o);
  const w = new Wire({ cmd: ctx.versions.claudeBin, args, cwd: work, env: claudeEnv(), rec });
  return { w, work, scrub, dir, args };
}

/** can_use_tool 요청에 허락으로 답한다(사무실이 하는 그대로). 본 요청은 거울에 남긴다. */
function autoAllow(w: Wire, asked: Json[]) {
  w.onMessage = (m) => {
    if (m.type !== 'control_request' || m.request?.subtype !== 'can_use_tool') return;
    asked.push({ tool_name: m.request.tool_name, input: m.request.input, tool_use_id: m.request.tool_use_id, keys: Object.keys(m.request), at: w.ms });
    w.send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { behavior: 'allow', updatedInput: m.request.input ?? {} } } });
  };
}

async function claudePermission(ctx: Ctx) {
  const { w, work, scrub, dir, args } = startClaude(ctx, 'permission', { permissionMode: 'manual', tools: ['Write', 'Read'] });
  const asked: Json[] = [];
  autoAllow(w, asked);
  w.send(userMsg('Create a file named hello.txt in the current directory containing exactly: hello from the probe. Then reply with the single word done.'));
  const finished = await w.until(() => results(w).length > 0, 90_000);
  const exit = await w.finish();
  const cancel = w.msgs.filter((m) => m.type === 'control_cancel_request').length;
  saveMeta(ctx, 'claude', 'permission', scrub, dir, {
    note: `can_use_tool ${asked.length}건 (${asked.map((a) => a.tool_name).join(',') || '없음'}), 파일 만들어짐 ${existsSync(path.join(work, 'hello.txt'))}, result ${results(w)[0]?.subtype ?? '없음'}`,
    argv: ['claude', ...args], exit, finished, ms: w.ms, asked, cancelRequests: cancel,
    types: histogram(w.msgs, (m) => `${m.type}${m.subtype ? '/' + m.subtype : ''}`), results: results(w).map(resultSummary),
  });
}

async function claudeInterrupt(ctx: Ctx) {
  const { w, scrub, dir, args } = startClaude(ctx, 'interrupt', { permissionMode: 'manual', tools: ['Read'] });
  w.send(userMsg('Count from 1 to 500. Write each number on its own line followed by a short sentence about it. No tools.'));
  const started = await w.until(() => textDeltas(w).length > 0, 60_000);
  const interruptAt = w.times.length;
  const requestId = `stop-${Date.now()}`;
  const sentAt = w.ms;
  w.send({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } });
  const responded = await w.until(() => w.msgs.some((m) => m.type === 'control_response'), 20_000);
  const gotResult = await w.until(() => results(w).length > 0, 20_000);
  const afterInterrupt = w.msgs.slice(interruptAt);
  // 중단한 뒤에도 같은 프로세스가 다음 턴을 받는가
  const before = results(w).length;
  w.send(userMsg('Reply with exactly: ALIVE'));
  const alive = await w.until(() => results(w).length > before, 60_000);
  const exit = await w.finish();
  saveMeta(ctx, 'claude', 'interrupt', scrub, dir, {
    note: `중단 응답 ${responded ? 'control_response 옴' : '없음'}, 중단 뒤 result ${gotResult ? results(w)[0]?.subtype + '/is_error=' + results(w)[0]?.is_error : '없음'}, 중단 뒤 다음 턴 ${alive ? '받음' : '못 받음'}`,
    argv: ['claude', ...args], exit, started, sentAtMs: sentAt, ms: w.ms, requestId,
    controlResponses: w.msgs.filter((m) => m.type === 'control_response'),
    typesAfterInterrupt: histogram(afterInterrupt, (m) => `${m.type}${m.subtype ? '/' + m.subtype : ''}`),
    results: results(w).map(resultSummary),
  });
}

async function claudeMidTurn(ctx: Ctx) {
  const { w, scrub, dir, args } = startClaude(ctx, 'midturn-stdin', { permissionMode: 'manual', tools: ['Read'] });
  w.send(userMsg('Write the integers from 1 to 120, one per line, with no other text. No tools.'));
  const started = await w.until(() => textDeltas(w).length > 0, 60_000);
  const sentAt = w.ms;
  const idxAtSend = w.msgs.length;
  w.send(userMsg('Change of plan: stop the numbers. Reply with exactly: SECOND-MESSAGE-RECEIVED'));
  await w.until(() => results(w).length > 0, 90_000);
  const firstResultAt = w.ms;
  // 둘째 메시지가 큐에 있다면 곧 두 번째 턴이 시작된다
  const second = await w.until(() => results(w).length > 1, 30_000);
  const exit = await w.finish();
  const assistantTexts = w.msgs.filter((m) => m.type === 'assistant').map((m) => (m.message?.content ?? []).filter((c: Json) => c.type === 'text').map((c: Json) => String(c.text).slice(0, 120)).join(' ')).filter(Boolean);
  const all = w.msgs.map((m) => JSON.stringify(m)).join('\n');
  const echoed = all.includes('SECOND-MESSAGE-RECEIVED');
  saveMeta(ctx, 'claude', 'midturn-stdin', scrub, dir, {
    note: `result ${results(w).length}개 (둘째 턴 ${second ? '있음' : '없음'}), 둘째 메시지의 지시가 모델 출력에 반영됨 ${assistantTexts.some((t) => t.includes('SECOND-MESSAGE-RECEIVED'))}`,
    argv: ['claude', ...args], exit, started, ms: w.ms, secondSentAtMs: sentAt, firstResultAtMs: firstResultAt, msgsBeforeSecond: idxAtSend, echoedAnywhere: echoed,
    assistantTexts, results: results(w).map(resultSummary), types: histogram(w.msgs, (m) => `${m.type}${m.subtype ? '/' + m.subtype : ''}`),
  });
}

async function claudeMcp(ctx: Ctx, scenario: string, o: { allow: boolean; transport: 'http' | 'stdio'; noTurn?: boolean }) {
  const srv = o.transport === 'http' ? await startMcpHttp() : null;
  const config = o.transport === 'http'
    ? { mcpServers: { office: { type: 'http', url: `http://127.0.0.1:${srv!.port}/mcp`, headers: { Authorization: `Bearer ${srv!.token}` } } } }
    : { mcpServers: { office: { type: 'stdio', command: process.execPath, args: [path.join(ROOT, 'scripts', 'record-cli.ts'), '--mcp-stdio-shim'] } } };
  const extra: Array<[string, string]> = srv ? [[srv.token, '<TOKEN>']] : [];
  const { w, scrub, dir, args } = startClaude(ctx, scenario, { permissionMode: 'acceptEdits', tools: ['Read'], allowedTools: o.allow ? ['mcp__office__office_ping'] : undefined, mcpConfig: JSON.stringify(config) }, extra);
  const asked: Json[] = [];
  autoAllow(w, asked);
  if (!o.noTurn) w.send(userMsg('Call the office_ping tool once with message "hello". Then reply with exactly the text it returned and nothing else.'));
  let finished: boolean;
  if (o.noTurn) { await new Promise((r) => setTimeout(r, 12_000)); finished = false; } else finished = await w.until(() => results(w).length > 0, 90_000);
  const init = w.msgs.find((m) => m.type === 'system' && m.subtype === 'init');
  const exit = await w.finish(o.noTurn ? 1 : 8000);
  const toolUses = w.msgs.filter((m) => m.type === 'assistant').flatMap((m) => (m.message?.content ?? []).filter((c: Json) => c.type === 'tool_use').map((c: Json) => ({ name: c.name, input: c.input })));
  const toolResults = w.msgs.filter((m) => m.type === 'user').flatMap((m) => (Array.isArray(m.message?.content) ? m.message.content : []).filter((c: Json) => c.type === 'tool_result').map((c: Json) => ({ is_error: c.is_error, content: c.content })));
  const final = results(w)[0];
  if (srv) {
    const f = new Recorder(path.join(dir, `${scenario}.server.jsonl`), scrub);
    for (const l of srv.log) f.add(l.dir, l.line);
  }
  const rpcMethods = srv ? srv.log.filter((l) => l.dir === 'req').map((l) => (JSON.parse(l.line).body?.method ?? JSON.parse(l.line).method)) : [];
  srv?.close();
  saveMeta(ctx, 'claude', scenario, scrub, dir, {
    note: `${o.transport} 서버 상태 ${JSON.stringify(init?.mcp_servers ?? null)}, 도구 목록에 있음 ${JSON.stringify(init?.tools ?? []).includes('mcp__office__office_ping')}, 호출 ${toolUses.filter((t) => String(t.name).includes('office_ping')).length}회, can_use_tool ${asked.length}건, 결과 ${final ? JSON.stringify(final.result).slice(0, 80) : '없음'}`,
    argv: ['claude', ...args], exit, finished, ms: w.ms, init: init ? { mcp_servers: init.mcp_servers, tools: init.tools, permissionMode: init.permissionMode, model: init.model } : null,
    initAtMs: init ? w.times[w.msgs.indexOf(init)] : null, asked, toolUses, toolResults, rpcMethods, results: results(w).map(resultSummary), stderr: w.stderr.slice(-600),
  });
  return { ok: !!final && JSON.stringify(final.result).includes(PONG) };
}

// ── codex ──
const CODEX_MODEL = 'gpt-6-luna';
const CODEX_COMMON = ['--json', '--ignore-user-config', '-m', CODEX_MODEL, '-c', 'model_reasoning_effort="low"', '--skip-git-repo-check'];

function startCodex(ctx: Ctx, scenario: string, args: string[], work: string, prompt: string) {
  const { rec, scrub, dir } = open(ctx, 'codex', scenario, work);
  const w = new Wire({ cmd: 'codex', args, cwd: work, env: cleanEnv(), rec });
  w.send(prompt);
  w.endStdin();
  return { w, scrub, dir };
}

const itemSummary = (w: Wire) => w.msgs.filter((m) => String(m.type).startsWith('item.')).map((m) => ({ type: m.type, item: m.item ? { ...m.item, aggregated_output: typeof m.item.aggregated_output === 'string' ? m.item.aggregated_output.slice(0, 80) : m.item.aggregated_output, text: typeof m.item.text === 'string' ? m.item.text.slice(0, 80) : m.item.text } : m.item }));

async function codexScenarios(ctx: Ctx, want: (s: string) => boolean) {
  const work = workdir(ctx, 'codex');
  let threadId = '';
  if (want('first-turn') || want('resume')) {
    const args = ['exec', ...CODEX_COMMON, '-C', work, '-s', 'workspace-write', '-'];
    const { w, scrub, dir } = startCodex(ctx, 'first-turn', args, work, 'Create a file named hello.txt in the current directory containing exactly: hello from codex. Then reply with the single word done.');
    await w.until(() => w.msgs.some((m) => m.type === 'turn.completed' || m.type === 'turn.failed'), 120_000);
    const exit = await w.finish(10_000);
    threadId = String(w.msgs.find((m) => m.type === 'thread.started')?.thread_id ?? '');
    saveMeta(ctx, 'codex', 'first-turn', scrub, dir, {
      note: `이벤트 ${JSON.stringify(histogram(w.msgs, (m) => String(m.type)))}, thread_id ${threadId ? '있음' : '없음'}, 파일 ${existsSync(path.join(work, 'hello.txt'))}, 종료 ${JSON.stringify(exit)}`,
      argv: ['codex', ...args], promptViaStdin: true, exit, ms: w.ms, threadId, usage: w.msgs.find((m) => m.type === 'turn.completed')?.usage, items: itemSummary(w), stderr: w.stderr.slice(-800),
      topLevelKeysByType: Object.fromEntries([...new Set(w.msgs.map((m) => String(m.type)))].map((t) => [t, Object.keys(w.msgs.find((m) => String(m.type) === t) ?? {})])),
    });
  }
  if (want('resume') && threadId) {
    // resume에는 -C와 -s가 없다(도움말에도 없다): cwd는 프로세스의 것을 쓰고, 샌드박스는 세션에서 이어받는지 본다
    const args = ['exec', 'resume', threadId, ...CODEX_COMMON, '-'];
    const { w, scrub, dir } = startCodex(ctx, 'resume', args, work, 'Append a second line "second" to hello.txt, keeping the first line. Then reply with the full content of hello.txt.');
    await w.until(() => w.msgs.some((m) => m.type === 'turn.completed' || m.type === 'turn.failed'), 120_000);
    const exit = await w.finish(10_000);
    const content = existsSync(path.join(work, 'hello.txt')) ? readFileSync(path.join(work, 'hello.txt'), 'utf8') : '';
    saveMeta(ctx, 'codex', 'resume', scrub, dir, {
      note: `같은 thread_id ${w.msgs.find((m) => m.type === 'thread.started')?.thread_id === threadId ? '이어짐' : '다른 id'}, 이벤트 ${JSON.stringify(histogram(w.msgs, (m) => String(m.type)))}, 둘째 줄 쓰임 ${content.includes('second')}, 종료 ${JSON.stringify(exit)}`,
      argv: ['codex', ...args], promptViaStdin: true, exit, ms: w.ms, threadId, threadIdOfResume: w.msgs.find((m) => m.type === 'thread.started')?.thread_id, fileAfter: content, usage: w.msgs.find((m) => m.type === 'turn.completed')?.usage, items: itemSummary(w), stderr: w.stderr.slice(-800),
    });
  }
  if (want('resume') && threadId) {
    // resume에는 -s가 없으니 같은 뜻의 설정 덮어쓰기(-c)로 쓰기를 열어 본다
    const args = ['exec', 'resume', threadId, ...CODEX_COMMON, '-c', 'sandbox_mode="workspace-write"', '-'];
    const { w, scrub, dir } = startCodex(ctx, 'resume-sandbox-override', args, work, 'Append a second line "second" to hello.txt, keeping the first line. Then reply with the full content of hello.txt.');
    await w.until(() => w.msgs.some((m) => m.type === 'turn.completed' || m.type === 'turn.failed'), 120_000);
    const exit = await w.finish(10_000);
    const content = existsSync(path.join(work, 'hello.txt')) ? readFileSync(path.join(work, 'hello.txt'), 'utf8') : '';
    saveMeta(ctx, 'codex', 'resume-sandbox-override', scrub, dir, {
      note: `resume + -c sandbox_mode="workspace-write": 둘째 줄 쓰임 ${content.includes('second')}, 종료 ${JSON.stringify(exit)}`,
      argv: ['codex', ...args], promptViaStdin: true, exit, ms: w.ms, threadId, fileAfter: content, usage: w.msgs.find((m) => m.type === 'turn.completed')?.usage, items: itemSummary(w), stderr: w.stderr.slice(-800),
    });
  }
  if (want('sigterm')) {
    const w2 = workdir(ctx, 'codex-sigterm');
    const args = ['exec', ...CODEX_COMMON, '-C', w2, '-s', 'read-only', '-'];
    const { w, scrub, dir } = startCodex(ctx, 'sigterm', args, w2, 'Run the shell command `sleep 60` and then reply with the word done.');
    // codex는 글을 통째로(item.completed) 내보내므로, 오래 도는 명령이 시작된 뒤에 끊는다
    const started = await w.until(() => w.msgs.some((m) => m.type === 'item.started' && m.item?.type === 'command_execution'), 60_000);
    await new Promise((r) => setTimeout(r, 1500));
    w.kill('SIGTERM');
    const exit = await w.wait(15_000);
    if (!exit) w.kill('SIGKILL');
    await w.closed;
    // 끊은 뒤에도 codex가 띄운 `sleep 60`이 남아 있는가(남아 있으면 정리한다)
    await new Promise((r) => setTimeout(r, 1000));
    const orphans = execFileSync('ps', ['-eo', 'pid=,ppid=,command='], { encoding: 'utf8' }).split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.slice(2).join(' ') === 'sleep 60' && p[1] === '1');
    for (const o of orphans) { try { process.kill(Number(o[0])); } catch { /* 이미 끝났다 */ } }
    saveMeta(ctx, 'codex', 'sigterm', scrub, dir, {
      note: `SIGTERM 뒤 종료 ${JSON.stringify(w.exit)}, 마지막 이벤트 ${w.msgs.at(-1)?.type}, turn.completed/failed 있음 ${w.msgs.some((m) => m.type === 'turn.completed' || m.type === 'turn.failed')}, 고아로 남은 sleep ${orphans.length}개`,
      argv: ['codex', ...args], started, exit: w.exit, orphanedChildren: orphans.length, types: histogram(w.msgs, (m) => String(m.type)), stderr: w.stderr.slice(-400),
    });
  }
}

// ── gemini ──
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_COMMON = ['-o', 'stream-json', '--skip-trust', '-m', GEMINI_MODEL, '--allowed-mcp-server-names', 'none', '-e', 'none'];

function startGemini(ctx: Ctx, scenario: string, args: string[], work: string) {
  const { rec, scrub, dir } = open(ctx, 'gemini', scenario, work);
  const w = new Wire({ cmd: 'gemini', args, cwd: work, env: cleanEnv(), rec });
  w.endStdin();
  return { w, scrub, dir };
}

/** 가장 작은 옵션으로 한 번 불러 본다. 로그인이 안 되거나 계정이 막혀 있으면 이벤트 없이 오류로 끝난다(이 경우 모델은 호출되지 않는다). */
async function geminiAuthWorks(ctx: Ctx): Promise<boolean> {
  if (ctx.geminiAuth !== undefined) return ctx.geminiAuth;
  const work = workdir(ctx, 'gemini-auth');
  const args = ['-p', 'Reply with exactly: ok', '-o', 'stream-json', '--skip-trust'];
  const { w, scrub, dir } = startGemini(ctx, 'auth-minimal', args, work);
  await w.until(() => w.msgs.some((m) => m.type === 'result'), 90_000);
  const exit = await w.finish(8000);
  ctx.geminiAuth = w.msgs.some((m) => m.type === 'result' && m.status === 'success');
  saveMeta(ctx, 'gemini', 'auth-minimal', scrub, dir, {
    note: `헤드리스 인증 ${ctx.geminiAuth ? '됨' : '안 됨'}: stdout 이벤트 ${w.msgs.length}개, 종료 ${JSON.stringify(exit)}, stderr 첫 줄 ${JSON.stringify(w.stderr.split('\n')[0]?.slice(0, 160))}`,
    argv: ['gemini', ...args], exit, ms: w.ms, types: histogram(w.msgs, (m) => String(m.type)), stderrHead: w.stderr.split('\n').slice(0, 3), authSetting: 'oauth-personal(사용자의 기존 로그인)',
  });
  return ctx.geminiAuth;
}

async function geminiScenarios(ctx: Ctx, want: (s: string) => boolean) {
  if (!(await geminiAuthWorks(ctx))) { console.log('  gemini 인증이 안 돼서 나머지 시나리오는 건너뜀'); return; }
  const work = workdir(ctx, 'gemini');
  const sessionId = randomUUID();
  let firstOk = false;
  if (want('first-turn') || want('resume')) {
    const args = ['-p', 'Create a file named hello.txt in the current directory containing exactly: hello from gemini. Then reply with the single word done.', ...GEMINI_COMMON, '--approval-mode', 'auto_edit', '--session-id', sessionId];
    const { w, scrub, dir } = startGemini(ctx, 'first-turn', args, work);
    await w.until(() => w.msgs.some((m) => m.type === 'result'), 120_000);
    const exit = await w.finish(10_000);
    const init = w.msgs.find((m) => m.type === 'init');
    const result = w.msgs.find((m) => m.type === 'result');
    firstOk = !!result;
    saveMeta(ctx, 'gemini', 'first-turn', scrub, dir, {
      note: `이벤트 ${JSON.stringify(histogram(w.msgs, (m) => String(m.type)))}, init.session_id가 지정한 --session-id와 같음 ${init?.session_id === sessionId}, result ${result?.status ?? '없음'}, 파일 ${existsSync(path.join(work, 'hello.txt'))}, 종료 ${JSON.stringify(exit)}`,
      argv: ['gemini', ...args], exit, ms: w.ms, sessionId, initSessionId: init?.session_id, result, stderr: w.stderr.slice(-1200),
      topLevelKeysByType: Object.fromEntries([...new Set(w.msgs.map((m) => String(m.type)))].map((t) => [t, Object.keys(w.msgs.find((m) => String(m.type) === t) ?? {})])),
      toolEvents: w.msgs.filter((m) => m.type === 'tool_use' || m.type === 'tool_result'),
    });
  }
  if (want('resume') && firstOk) {
    const args = ['-p', 'Read hello.txt and reply with its exact content.', ...GEMINI_COMMON, '--approval-mode', 'auto_edit', '-r', sessionId];
    const { w, scrub, dir } = startGemini(ctx, 'resume', args, work);
    await w.until(() => w.msgs.some((m) => m.type === 'result'), 120_000);
    const exit = await w.finish(10_000);
    const init = w.msgs.find((m) => m.type === 'init');
    const assistant = w.msgs.filter((m) => m.type === 'message' && m.role === 'assistant').map((m) => String(m.content)).join('');
    saveMeta(ctx, 'gemini', 'resume', scrub, dir, {
      note: `-r <uuid> ${w.msgs.some((m) => m.type === 'result') ? '동작' : '실패'}, init.session_id 같음 ${init?.session_id === sessionId}, 답에 첫 턴의 파일 내용 ${assistant.includes('hello from gemini')}, 종료 ${JSON.stringify(exit)}`,
      argv: ['gemini', ...args], exit, ms: w.ms, sessionId, initSessionId: init?.session_id, assistant: assistant.slice(0, 200), result: w.msgs.find((m) => m.type === 'result'), stderr: w.stderr.slice(-1200),
      types: histogram(w.msgs, (m) => String(m.type)),
    });
  }
  if (want('sigterm')) {
    const w2 = workdir(ctx, 'gemini-sigterm');
    const args = ['-p', 'Write the integers from 1 to 400, one per line, with a short sentence after each. Do not use tools.', ...GEMINI_COMMON, '--approval-mode', 'plan'];
    const { w, scrub, dir } = startGemini(ctx, 'sigterm', args, w2);
    const started = await w.until(() => w.msgs.some((m) => m.type === 'message' && m.role === 'assistant'), 60_000);
    await new Promise((r) => setTimeout(r, 1500));
    w.kill('SIGTERM');
    const exit = await w.wait(15_000);
    if (!exit) w.kill('SIGKILL');
    await w.closed;
    saveMeta(ctx, 'gemini', 'sigterm', scrub, dir, {
      note: `SIGTERM 뒤 종료 ${JSON.stringify(w.exit)}, result 이벤트 ${w.msgs.some((m) => m.type === 'result') ? '있음' : '없음'}, 마지막 이벤트 ${w.msgs.at(-1)?.type}`,
      argv: ['gemini', ...args], started, exit: w.exit, types: histogram(w.msgs, (m) => String(m.type)), stderr: w.stderr.slice(-400),
    });
  }
}

// ── 진짜 사무실: 진짜 서버 프로세스, 맥스 한 명, 일꾼 한 명(U7 스모크) ──
const OFFICE_PROMPT = (agent: 'claude' | 'codex') =>
  `일꾼 한 명(agent: ${agent}, role: code)에게만 hello.txt 파일에 "안녕" 한 줄을 쓰게 해 주세요. 다른 할 일은 만들지 마세요. 끝나면 한 문장으로 알려 주세요.`;

async function officeReal(ctx: Ctx, agent: 'claude' | 'codex') {
  const started = Date.now();
  const tmp = realpathSync(mkdtempSync(path.join(ctx.scratch, `office-${agent}-`)));
  const rec = path.join(tmp, 'rec');
  const office = await spawnOffice({ env: { ...cleanEnv(), BUREAU_DIR: path.join(tmp, 'office'), BUREAU_RECORD: rec } });
  const answered = new Set<string>();
  const evs = () => office.events();
  const settled = () => evs().some((e) => e.k === 'settle');
  const openAsks = () => {
    const done = new Set(evs().flatMap((e) => (e.k === 'ask_done' ? [e.requestId] : [])));
    return evs().flatMap((e) => (e.k === 'ask' && !done.has(e.requestId) && !answered.has(e.requestId) ? [e] : []));
  };
  let mission: MissionInfo | undefined;
  try {
    await office.until((m) => m.some((x) => x.t === 'hello'), 10_000);
    const settings = { chefModel: 'haiku', teamModel: 'haiku', permission: 'auto' as const, codexModel: CODEX_MODEL };
    office.send({ t: 'settings', settings });
    await office.until((m) => m.some((x) => x.t === 'settings'), 10_000);
    office.send({ t: 'start', prompt: OFFICE_PROMPT(agent) });
    const deadline = Date.now() + 300_000;
    while (!settled()) {
      await office.until(() => settled() || openAsks().length > 0, Math.max(1, deadline - Date.now()));
      for (const a of openAsks()) {
        answered.add(a.requestId);
        office.send(a.kind === 'question' ? { t: 'reply', requestId: a.requestId, text: '알아서 정해 주세요.' } : { t: 'answer', requestId: a.requestId, allow: true });
      }
    }
    mission = office.msgs.flatMap((m) => (m.t === 'mission' ? [m.mission] : [])).at(-1);
    office.send({ t: 'new' });
    await office.until((m) => m.some((x) => x.t === 'closed'), 30_000);
  } finally {
    await office.stop();
  }
  if (!mission) throw new Error('미션 정보가 오지 않았다');

  const hello = path.join(mission.folder, 'hello.txt');
  const helloText = existsSync(hello) ? readFileSync(hello, 'utf8') : null;
  const raws = readdirSync(rec).filter((f) => f.endsWith('.raw.jsonl')).sort();
  const rawOf = (f: string) => readFileSync(path.join(rec, f), 'utf8');
  const leadRaw = raws.find((f) => /-1-claude\.raw\.jsonl$/.test(f));
  const planCalls = leadRaw ? (rawOf(leadRaw).match(/\\"name\\":\\"mcp__office__office_plan\\"/g) ?? []).length : 0;
  const mcp = readFileSync(path.join(rec, 'lead-mcp.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Json);
  const logged = readFileSync(path.join(rec, `${mission.id}.logged.jsonl`), 'utf8');
  const events = logged.split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { ev: Json }).ev);
  const hires = events.filter((e) => e.k === 'hire').map((e) => e.agent);

  const scrub = makeScrub([[mission.folder, '/work/mission'], [path.join(tmp, 'office'), '<TMP>/office'], [tmp, '<TMP>/office-run']]);
  const out = path.join(FIXTURES, 'scenarios');
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, `real-u7-${agent}.logged.jsonl`), logged.split('\n').filter(Boolean).map(scrub).join('\n') + '\n');
  const observed = {
    versions: { claude: ctx.versions.claude, codex: ctx.versions.codex }, settings: { chefModel: 'haiku', teamModel: 'haiku', permission: 'auto', codexModel: CODEX_MODEL },
    prompt: OFFICE_PROMPT(agent), ms: Date.now() - started, status: mission.status, hires, planCalls, helloText,
    sessions: raws.map((f) => f.replace(mission!.id, '<MISSION>')),
    mcp: { requests: mcp.length, methods: [...new Set(mcp.map((r) => r.method))], origins: [...new Set(mcp.map((r) => r.origin))], userAgents: [...new Set(mcp.map((r) => r.userAgent))] },
    settle: events.find((e) => e.k === 'settle')?.text ?? null, end: events.find((e) => e.k === 'end') ?? null,
    kinds: events.map((e) => e.k).join(' '), answered: answered.size,
  };
  writeFileSync(path.join(out, `real-u7-${agent}.meta.json`), scrub(JSON.stringify(observed, null, 2)) + '\n');
  console.log(`  [office:${agent}] 상태 ${mission.status}, office_plan ${planCalls}번, 일꾼 ${hires.join(',')}, hello.txt ${JSON.stringify(helloText)}, MCP 요청 ${mcp.length}개(Origin ${JSON.stringify(observed.mcp.origins)}), ${Math.round(observed.ms / 1000)}초`);
  await new Promise((r) => setTimeout(r, 1500)); // 서버의 늦은 저장이 지워진 폴더를 건드리지 않도록
  rmSync(tmp, { recursive: true, force: true });
}

// ── 실행 ──
interface Step { id: string; cli: string; what: string; calls: string; run: (ctx: Ctx) => Promise<unknown> }

function steps(only: string[]): Step[] {
  const sel = (cli: string, scenario: string) => only.length === 0 || only.includes(cli) || only.includes(`${cli}:${scenario}`);
  const all: Step[] = [
    { id: 'claude:permission', cli: 'claude', what: 'Write 도구를 시키고 can_use_tool 요청에 허락으로 답한다', calls: '2', run: claudePermission },
    { id: 'claude:interrupt', cli: 'claude', what: '긴 턴을 시작하고 interrupt를 보낸 뒤, 같은 프로세스가 다음 턴을 받는지 본다', calls: '2', run: claudeInterrupt },
    { id: 'claude:midturn-stdin', cli: 'claude', what: '턴이 도는 중에 stdin으로 둘째 사용자 메시지를 보낸다', calls: '1-2', run: claudeMidTurn },
    { id: 'claude:mcp-http', cli: 'claude', what: '127.0.0.1의 작은 MCP 서버(http, bearer)를 붙이고 --allowedTools로 호출을 허용한다', calls: '2', run: async (c) => { const r = await claudeMcp(c, 'mcp-http', { allow: true, transport: 'http' }); if (!r.ok) { console.log('  http가 안 됐다: stdio 샘플로 다시 시도'); await claudeMcp(c, 'mcp-stdio', { allow: true, transport: 'stdio' }); } } },
    { id: 'claude:mcp-http-noallow', cli: 'claude', what: '대조군: --allowedTools 없이 같은 MCP 호출(승인 요청이 오는지)', calls: '2', run: (c) => claudeMcp(c, 'mcp-http-noallow', { allow: false, transport: 'http' }) },
    { id: 'claude:mcp-http-noturn', cli: 'claude', what: '모델 호출 없이 MCP 서버 상태가 init에 나오는지(메시지를 보내지 않고 12초 기다린다)', calls: '0', run: (c) => claudeMcp(c, 'mcp-http-noturn', { allow: true, transport: 'http', noTurn: true }) },
    { id: 'claude:office-u7', cli: 'claude', what: '진짜 서버로 미션 하나(맥스가 office_plan으로 claude 일꾼 한 명). Logged[]를 tests/fixtures/scenarios/에', calls: '약 3-5', run: (c) => officeReal(c, 'claude') },
    { id: 'codex:office-u7', cli: 'codex', what: `진짜 서버로 미션 하나(맥스는 claude, 일꾼은 codex ${CODEX_MODEL})`, calls: '약 3-5', run: (c) => officeReal(c, 'codex') },
    { id: 'codex:first-turn', cli: 'codex', what: `codex exec --json (${CODEX_MODEL}, workspace-write)`, calls: '1', run: (c) => codexScenarios(c, (s) => s === 'first-turn') },
    { id: 'codex:resume', cli: 'codex', what: 'codex exec resume <thread_id> --json (첫 턴을 함께 돌린다)', calls: '1', run: (c) => codexScenarios(c, (s) => s === 'resume') },
    { id: 'codex:sigterm', cli: 'codex', what: '턴 도중 SIGTERM', calls: '1(일부)', run: (c) => codexScenarios(c, (s) => s === 'sigterm') },
    { id: 'gemini:first-turn', cli: 'gemini', what: `gemini -p -o stream-json (${GEMINI_MODEL}, auto_edit, --session-id)`, calls: '1-2', run: (c) => geminiScenarios(c, (s) => s === 'first-turn') },
    { id: 'gemini:resume', cli: 'gemini', what: 'gemini -r <uuid> 같은 cwd(첫 턴을 함께 돌린다)', calls: '1-2', run: (c) => geminiScenarios(c, (s) => s === 'resume') },
    { id: 'gemini:sigterm', cli: 'gemini', what: '턴 도중 SIGTERM', calls: '1(일부)', run: (c) => geminiScenarios(c, (s) => s === 'sigterm') },
  ];
  const picked = all.filter((s) => sel(s.cli, s.id.split(':')[1]));
  // resume은 첫 턴이 필요해서, 둘이 함께 선택되면 첫 턴을 두 번 돌리지 않는다(resume 단계가 첫 턴도 기록한다)
  const hasResume = (cli: string) => picked.some((s) => s.id === `${cli}:resume`);
  return picked.filter((s) => !(s.id.endsWith(':first-turn') && hasResume(s.cli) && (s.cli === 'codex' || s.cli === 'gemini')));
}

/** 버전 출력에서 숫자로 시작하는 낱말을 고른다(“2.1.322 (Claude Code)”, “codex-cli 0.167.1”, “0.55.1”). */
function cliVersion(cmd: string, args: string[]): string | null {
  try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 15_000 }).trim().split(/\s+/).find((w) => /^\d+\.\d+/.test(w)) ?? null; } catch { return null; }
}

async function main() {
  if (process.argv.includes('--mcp-stdio-shim')) return runStdioShim();
  const argv = process.argv.slice(2);
  const yes = argv.includes('--yes');
  const onlyArg = argv.indexOf('--only');
  const only = onlyArg >= 0 ? (argv[onlyArg + 1] ?? '').split(',').filter(Boolean) : [];
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|ANTHROPIC)/.test(k)) delete process.env[k];

  const claudeBin = (await findClaude())?.path ?? '';
  const versions: Record<string, string> = {
    claude: claudeBin ? (cliVersion(claudeBin, ['--version']) ?? '') : '',
    codex: cliVersion('codex', ['--version']) ?? '',
    gemini: cliVersion('gemini', ['--version']) ?? '',
    claudeBin,
  };
  const plan = steps(only).filter((s) => {
    if (!versions[s.cli]) { console.log(`건너뜀 ${s.id}: ${s.cli}를 찾지 못했다`); return false; }
    return true;
  });
  console.log('이 스크립트는 구독 사용량을 씁니다(모델을 실제로 호출합니다). 한 줄짜리 요청과 가장 싼 모델만 씁니다.');
  console.log(`버전: claude ${versions.claude || '없음'}, codex ${versions.codex || '없음'}, gemini ${versions.gemini || '없음'}`);
  console.log('실행할 것:');
  for (const s of plan) console.log(`  ${s.id.padEnd(26)} 모델 호출 ${s.calls.padEnd(8)} ${s.what}`);
  console.log(`쓰는 곳: ${path.relative(ROOT, FIXTURES)}/<cli>-<버전>/ (임시 작업 폴더는 ${os.tmpdir()} 아래에 만들고 끝나면 지웁니다)`);
  console.log('사용자 설정은 건드리지 않습니다(mcp add, 로그인, 로그아웃 없음).');
  if (!plan.length) return;
  if (!yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>((r) => rl.question('계속할까요? (yes 입력) ', r));
    rl.close();
    if (answer.trim().toLowerCase() !== 'yes') { console.log('멈췄습니다.'); return; }
  }
  const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'record-cli-')));
  const ctx: Ctx = { scratch, versions, summary: [], recorders: [] };
  for (const s of plan) {
    console.log(`\n▶ ${s.id}`);
    try { await s.run(ctx); } catch (e) { console.log(`  실패: ${String(e).slice(0, 300)}`); }
    for (const r of ctx.recorders.splice(0)) r.finalize();
  }
  rmSync(scratch, { recursive: true, force: true });
  console.log('\n끝. 만든 파일을 git status로 확인하고, 커밋하기 전에 홈 경로와 이메일이 남지 않았는지 grep으로 확인하세요.');
}

await main();
