// 가짜 에이전트가 내보내는 줄을 만드는 곳. 모양은 전부 tests/fixtures의 녹화에서 복제한 뒤 값만 바꾼다(줄을 새로 지어내지 않는다).
// 녹화에 없는 필드를 쓰는 곳에는 이유를 적었다.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

export type Json = Record<string, any>;

const FIXTURES = new URL('../fixtures/', import.meta.url);

const memo = new Map<string, Json[]>();

/** 녹화한 파일의 줄. `dir`로 거르고 JSON으로 읽는다. 이름은 `claude-2.1.322/permission.raw`처럼 확장자 앞까지. */
export function recorded(name: string, dir: string): Json[] {
  const key = `${name}:${dir}`;
  let rows = memo.get(key);
  if (!rows) {
    rows = readFileSync(new URL(`${name}.jsonl`, FIXTURES), 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(l) as { dir: string; line: string }).filter((r) => r.dir === dir).map((r) => JSON.parse(r.line) as Json);
    memo.set(key, rows);
  }
  return rows;
}

function pick(name: string, dir: string, match: (m: Json) => boolean): Json {
  const m = recorded(name, dir).find(match);
  if (!m) throw new Error(`녹화에 없는 줄이에요: ${name} ${dir}`);
  return structuredClone(m);
}

function patch(base: Json, over: Json): Json {
  for (const [k, v] of Object.entries(over)) {
    const cur = base[k];
    const plain = (x: unknown): x is Json => !!x && typeof x === 'object' && !Array.isArray(x);
    base[k] = plain(v) && plain(cur) ? patch(cur, v) : v;
  }
  return base;
}

function split(text: string, parts: number): string[] {
  const n = Math.max(1, Math.min(parts, text.length));
  const size = Math.ceil(text.length / n);
  return Array.from({ length: n }, (_, i) => text.slice(i * size, (i + 1) * size)).filter((p, i) => p.length || i === 0);
}

// ── claude (stream-json) ──

const CLAUDE_STREAM = 'claude-2.1.322/mcp-http.raw';
const stream = (type: string) => (m: Json) => m.type === 'stream_event' && m.event?.type === type;

export interface ClaudeWire {
  session: string;
  cwd: string;
  model: string;
  permissionMode: string;
  tools: string[];
  mcpServers: { name: string; status: string }[];
}

export class ClaudeLines {
  private msgs = 0;
  private current = '';
  private rateSent = false;

  readonly wire: ClaudeWire;

  constructor(wire: ClaudeWire) { this.wire = wire; }

  private ids = () => ({ session_id: this.wire.session, uuid: randomUUID() });
  private json = (m: Json) => JSON.stringify(m);

  private event(template: (m: Json) => boolean, id: string, over: Json = {}): string {
    return this.json(patch(pick(CLAUDE_STREAM, 'stdout', template), { ...this.ids(), api_message_id: id, ...over }));
  }

  /** 턴이 시작될 때마다 부른다: 한도 알림은 턴의 첫 요청 뒤에만 온다(녹화에서 그렇다) */
  turnStart() { this.rateSent = false; }

  init(): string {
    const w = this.wire;
    return this.json(patch(pick('claude-2.1.322/permission.raw', 'stdout', (m) => m.subtype === 'init'), {
      ...this.ids(), cwd: w.cwd, original_cwd: w.cwd, model: w.model, permissionMode: w.permissionMode, tools: w.tools, mcp_servers: w.mcpServers.map((s) => ({ ...s, source: 'dynamic' })),
    }));
  }

  private status = () => this.json(patch(pick(CLAUDE_STREAM, 'stdout', (m) => m.subtype === 'status'), this.ids()));

  private rate(): string[] {
    if (this.rateSent) return [];
    this.rateSent = true;
    return [this.json(patch(pick(CLAUDE_STREAM, 'stdout', (m) => m.type === 'rate_limit_event'), this.ids()))];
  }

  private assistant(id: string, block: Json): string {
    return this.json(patch(pick(CLAUDE_STREAM, 'stdout', (m) => m.type === 'assistant' && m.message?.content?.[0]?.type === block.type), {
      session_id: this.wire.session, uuid: randomUUID(), timestamp: new Date().toISOString(), message: { id, model: this.wire.model, content: [block] },
    }));
  }

  private messageStart(id: string): string {
    return this.event(stream('message_start'), id, { event: { message: { id, model: this.wire.model } } });
  }

  private open(): string { this.current = `msg_fake${++this.msgs}`; return this.current; }

  /** 글 한 덩이: 한 번의 요청(status)부터 message_stop까지 */
  say(text: string, chunks = 2): string[] {
    const id = this.open();
    const textBlock = (m: Json) => m.event?.content_block?.type === 'text';
    return [
      this.status(), this.messageStart(id), this.event((m) => stream('content_block_start')(m) && textBlock(m), id),
      ...split(text, chunks).map((p) => this.event((m) => m.event?.delta?.type === 'text_delta', id, { event: { delta: { text: p } } })),
      this.assistant(id, { type: 'text', text }),
      this.event(stream('content_block_stop'), id),
      this.event((m) => m.event?.delta?.stop_reason === 'end_turn', id),
      this.event(stream('message_stop'), id),
      ...this.rate(),
    ];
  }

  /** 글을 쓰는 도중까지만(중단 시험용): 끝나지 않는다 */
  saying(partial: string): string[] {
    const id = this.open();
    const lines = [this.status(), this.messageStart(id)];
    if (partial) {
      lines.push(this.event((m) => stream('content_block_start')(m) && m.event?.content_block?.type === 'text', id));
      lines.push(this.event((m) => m.event?.delta?.type === 'text_delta', id, { event: { delta: { text: partial } } }));
    }
    return lines;
  }

  /** 도구를 쓰겠다는 요청: block_stop까지. 허락을 묻는다면 이 뒤에 ask가 온다 */
  toolOpen(toolId: string, name: string, input: Json): string[] {
    const id = this.open();
    const text = JSON.stringify(input);
    const mid = Math.ceil(text.length / 2);
    const delta = (partial: string) => this.event((m) => m.event?.delta?.type === 'input_json_delta', id, { event: { delta: { partial_json: partial } } });
    return [
      this.status(), this.messageStart(id),
      this.event((m) => stream('content_block_start')(m) && m.event?.content_block?.type === 'tool_use', id, { event: { content_block: { id: toolId, name } } }),
      delta(''), delta(text.slice(0, mid)), delta(text.slice(mid)),
      this.assistant(id, { type: 'tool_use', id: toolId, name, input, caller: { type: 'direct' } }),
      this.event(stream('content_block_stop'), id),
    ];
  }

  ask(requestId: string, toolId: string, name: string, input: Json): string {
    return this.json(patch(pick('claude-2.1.322/permission.raw', 'stdout', (m) => m.type === 'control_request'), {
      request_id: requestId, request: { tool_name: name, display_name: name, input, description: name, tool_use_id: toolId },
    }));
  }

  /** 도구 결과까지. 실패한 결과(is_error)는 녹화에 없다: API의 tool_result 모양대로 is_error만 붙이고 메타는 뺀다 */
  toolClose(toolId: string, text: string, isError = false): string[] {
    const result = patch(pick('claude-2.1.322/mcp-http.raw', 'stdout', (m) => m.type === 'user' && m.message?.content?.[0]?.type === 'tool_result'), {
      session_id: this.wire.session, uuid: randomUUID(), timestamp: new Date().toISOString(),
      message: { content: [{ tool_use_id: toolId, type: 'tool_result', content: [{ type: 'text', text }] }] },
      tool_use_result: [{ type: 'text', text }], tool_result_meta: [{ id: toolId }],
    });
    if (isError) {
      result.message.content[0].is_error = true;
      delete result.tool_use_result;
      delete result.tool_result_meta;
    }
    return [
      this.event((m) => m.event?.delta?.stop_reason === 'tool_use', this.current),
      this.event(stream('message_stop'), this.current),
      ...this.rate(),
      this.json(result),
    ];
  }

  /** 턴의 끝. usage는 입력과 출력 토큰만 바꾼다 */
  result(text: string, usage?: { input_tokens?: number; output_tokens?: number }): string {
    const m = patch(pick(CLAUDE_STREAM, 'stdout', (x) => x.type === 'result'), { ...this.ids(), result: text });
    if (usage) patch(m.usage, usage);
    return this.json(m);
  }

  aborted(): string { return this.json(patch(pick('claude-2.1.322/interrupt.raw', 'stdout', (m) => m.type === 'result' && m.is_error === true), this.ids())); }
  interruptAck(requestId: string): string { return this.json(patch(pick('claude-2.1.322/interrupt.raw', 'stdout', (m) => m.type === 'control_response'), { response: { request_id: requestId } })); }
  interruptNote(): string {
    return this.json(patch(pick('claude-2.1.322/interrupt.raw', 'stdout', (m) => m.type === 'user'), { session_id: this.wire.session, uuid: randomUUID(), timestamp: new Date().toISOString() }));
  }
}

/** claude가 MCP 서버에 보낸 요청의 모양(녹화한 서버 쪽 기록). id는 호출하는 쪽이 정한다. */
export function mcpRequest(method: string, over: Json = {}): Json {
  const row = recorded('claude-2.1.322/mcp-http.server', 'req').find((r) => r.body?.method === method);
  if (!row) throw new Error(`녹화에 없는 MCP 요청이에요: ${method}`);
  return patch(structuredClone(row.body), over);
}

// ── codex (exec --json) ──

const CODEX = 'codex-0.167.1/first-turn.raw';
const item = (type: string, kind?: string) => (m: Json) => m.type === type && (kind === undefined || m.item?.type === kind);

export class CodexLines {
  private items = 0;

  private thread: string;

  constructor(thread: string) { this.thread = thread; }

  private json = (m: Json) => JSON.stringify(m);

  threadStarted(): string { return this.json(patch(pick(CODEX, 'stdout', (m) => m.type === 'thread.started'), { thread_id: this.thread })); }
  turnStarted(): string { return this.json(pick(CODEX, 'stdout', (m) => m.type === 'turn.started')); }

  command(run: string, output: string, exitCode: number): string[] {
    const id = `item_${this.items++}`;
    const base = { item: { id, command: run } };
    return [
      this.json(patch(pick(CODEX, 'stdout', item('item.started', 'command_execution')), base)),
      this.json(patch(pick(CODEX, 'stdout', item('item.completed', 'command_execution')), { item: { id, command: run, aggregated_output: output, exit_code: exitCode } })),
    ];
  }

  /** 조각 없이 item.completed에서 통째로 온다 */
  message(text: string): string {
    return this.json(patch(pick(CODEX, 'stdout', item('item.completed', 'agent_message')), { item: { id: `item_${this.items++}`, text } }));
  }

  turnCompleted(usage?: Json): string {
    const m = pick(CODEX, 'stdout', (x) => x.type === 'turn.completed');
    if (usage) m.usage = usage;
    return this.json(m);
  }
}
