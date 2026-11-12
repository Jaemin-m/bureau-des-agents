// 맥스만 쓰는 사무실 MCP 서버. Streamable HTTP의 작은 부분집합이고 답은 모두 JSON이다(SSE 없음).
// 부르는 쪽이 `POST /lead/<token>/mcp`에 `handle`을 단다. 토큰 하나가 맥스 프로세스 하나이고, 그 미션의 진행자를 가리킨다.
// 지킴: 토큰(128비트, 프로세스가 끝나거나 내려놓이면 회수), Host는 루프백만, Origin 헤더가 있으면 거절(브라우저는 늘 보낸다), 본문 256KB.
// 도구는 아래 표 하나에서 나온다: 맥스가 보는 스키마, 모양 검사, 진행자에게 넣을 입력.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ROLES } from '../../shared/activity.ts';
import { AGENT_KINDS } from '../../shared/protocol.ts';
import type { PlanSpec } from './dag.ts';
import type { Input, Reply } from './step.ts';

export type LeadInput = Extract<Input, { k: 'lead_plan' | 'lead_message' | 'lead_cancel' | 'lead_status' }>;
/** 토큰이 가리키는 곳: 그 미션의 진행자에게 맥스의 입력을 넣고 답을 받는다 */
export type LeadPort = (i: LeadInput) => Reply;

type Json = Record<string, unknown>;

interface LeadTool {
  name: `office_${string}`;
  description: string;
  inputSchema: { type: 'object'; properties: Json; required?: string[]; additionalProperties: false };
  /** 모양만 본다. 내용(고리, 없는 키, 한도)은 코어의 validatePlan이 본다. 문자열이면 맥스에게 돌려줄 오류다 */
  parse(args: Json): LeadInput | string;
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const optStr = (v: unknown) => v === undefined || isStr(v);
const ROLE_KEYS = Object.keys(ROLES).filter((r) => r !== 'chef');

const TASK_SCHEMA = {
  type: 'object',
  properties: {
    key: { type: 'string', description: '할 일의 id. 영어 소문자, 숫자, -' },
    title: { type: 'string', description: '화면에 보이는 짧은 제목(60자까지)' },
    brief: { type: 'string', description: '일꾼이 받을 구체적인 지시: 무엇을, 어떤 형태로 넘길지' },
    role: { type: 'string', enum: ROLE_KEYS },
    agent: { type: 'string', enum: [...AGENT_KINDS], description: '일꾼을 돌릴 CLI. 없으면 claude' },
    access: { type: 'string', enum: ['write', 'read'], description: '없으면 write' },
    after: { type: 'array', items: { type: 'string' }, description: '먼저 끝나야 하는 할 일의 key' },
  },
  required: ['key', 'title', 'brief', 'role'],
  additionalProperties: false,
};

function planSpec(v: unknown, i: number): PlanSpec | string {
  if (!v || typeof v !== 'object') return `tasks[${i}]는 객체여야 해요.`;
  const t = v as Json;
  for (const f of ['key', 'title', 'brief', 'role'] as const) if (!isStr(t[f])) return `tasks[${i}].${f}는 글이어야 해요.`;
  if (!optStr(t.agent) || !optStr(t.access)) return `tasks[${i}]의 agent와 access는 글이어야 해요.`;
  if (t.after !== undefined && !(Array.isArray(t.after) && t.after.every(isStr))) return `tasks[${i}].after는 key 목록이어야 해요.`;
  return {
    key: t.key as string, title: t.title as string, brief: t.brief as string, role: t.role as string,
    ...(t.agent !== undefined ? { agent: t.agent as string } : {}), ...(t.access !== undefined ? { access: t.access as string } : {}),
    ...(t.after !== undefined ? { after: t.after as string[] } : {}),
  };
}

const TOOLS: readonly LeadTool[] = [
  {
    name: 'office_plan',
    description: '할 일을 일꾼에게 나눠 맡겨요. 전부 받거나 전부 거절해요. 같은 key를 똑같이 다시 보내면 아무 일도 없고, 아직 시작하지 않은 key는 고칠 수 있어요. 보낸 뒤에는 턴을 끝내세요. 일이 끝나거나 질문이 오면 사무실이 소식으로 깨워요.',
    inputSchema: { type: 'object', properties: { tasks: { type: 'array', items: TASK_SCHEMA } }, required: ['tasks'], additionalProperties: false },
    parse(a) {
      if (!Array.isArray(a.tasks)) return 'tasks는 할 일 목록이어야 해요.';
      const specs: PlanSpec[] = [];
      for (const [i, v] of a.tasks.entries()) {
        const s = planSpec(v, i);
        if (typeof s === 'string') return s;
        specs.push(s);
      }
      return { k: 'lead_plan', specs };
    },
  },
  {
    name: 'office_message',
    description: '일꾼에게 말을 전해요. 질문에 답하거나(replyTo에 질문 id), 일하는 중이거나 끝난 일꾼에게 이어서 할 일을 줘요. requestId를 주면 같은 id는 한 번만 전해요.',
    inputSchema: {
      type: 'object',
      properties: { to: { type: 'string', description: '일꾼 id(w-…)' }, text: { type: 'string' }, replyTo: { type: 'string' }, requestId: { type: 'string' } },
      required: ['to', 'text'], additionalProperties: false,
    },
    parse(a) {
      if (!isStr(a.to) || !isStr(a.text) || !a.text.trim()) return 'to와 text를 글로 주세요.';
      if (!optStr(a.replyTo) || !optStr(a.requestId)) return 'replyTo와 requestId는 글이어야 해요.';
      return {
        k: 'lead_message', to: a.to, text: a.text,
        ...(a.replyTo !== undefined ? { replyTo: a.replyTo as string } : {}), ...(a.requestId !== undefined ? { requestId: a.requestId as string } : {}),
      };
    },
  },
  {
    name: 'office_cancel',
    description: '할 일(task) 하나를 취소하거나 일꾼(worker) 하나를 내보내요. 둘 중 하나만 주세요.',
    inputSchema: { type: 'object', properties: { task: { type: 'string' }, worker: { type: 'string' } }, additionalProperties: false },
    parse(a) {
      if (isStr(a.task) && a.worker === undefined) return { k: 'lead_cancel', target: { task: a.task } };
      if (isStr(a.worker) && a.task === undefined) return { k: 'lead_cancel', target: { worker: a.worker } };
      return 'task나 worker 중 하나만 주세요.';
    },
  },
  {
    name: 'office_status',
    description: '할 일, 일꾼, 열린 질문을 지금 상태 그대로 보여 줘요.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    parse: () => ({ k: 'lead_status' }),
  },
];

/** claude의 --mcp-config에 쓰는 서버 이름 */
const SERVER = 'office';

/** 맥스가 묻지 않고 쓰는 도구 이름(--allowedTools). 녹화에서 확인한 대로 도구마다 이름을 적는다 */
export const LEAD_TOOL_IDS = TOOLS.map((t) => `mcp__${SERVER}__${t.name}`);

export const leadMcpConfig = (base: string, token: string) =>
  JSON.stringify({ mcpServers: { [SERVER]: { type: 'http', url: `${base}/lead/${token}/mcp` } } });

const BODY_MAX = 256 * 1024;
const PATH = /^\/lead\/([0-9a-f]{32})\/mcp$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

const rpcOk = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const toolText = (text: string, isError: boolean) => ({ content: [{ type: 'text', text }], isError });

function refuse(res: ServerResponse, status: number) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
  res.end();
}

export class LeadMcp {
  private ports = new Map<string, LeadPort>();

  issue(port: LeadPort): string {
    const token = randomBytes(16).toString('hex');
    this.ports.set(token, port);
    return token;
  }

  revoke(token: string) { this.ports.delete(token); }

  private find(token: string): LeadPort | undefined {
    const want = Buffer.from(token);
    for (const [t, port] of this.ports) if (timingSafeEqual(Buffer.from(t), want)) return port;
    return undefined;
  }

  /** `/lead/`로 시작하는 요청이면 처리하고 true. 아니면 건드리지 않고 false. */
  handle = (req: IncomingMessage, res: ServerResponse): boolean => {
    const url = req.url ?? '';
    if (!url.startsWith('/lead/')) return false;
    if (req.headers.origin !== undefined) { refuse(res, 403); return true; }
    if (!loopbackHost(req)) { refuse(res, 403); return true; }
    const m = PATH.exec(url);
    const port = m ? this.find(m[1]) : undefined;
    if (!port) { refuse(res, 404); return true; }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return true; }
    if (Number(req.headers['content-length'] ?? 0) > BODY_MAX) { req.resume(); refuse(res, 413); return true; }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      size += c.length;
      if (size > BODY_MAX) { over = true; refuse(res, 413); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      let msg: unknown;
      try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { msg = undefined; }
      const out = rpc(msg, () => (m ? this.find(m[1]) : undefined));
      if (out === null) { res.writeHead(202); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return true;
  };
}

/** Host가 이 서버가 받은 루프백 주소와 포트인가(DNS 리바인딩 막기) */
function loopbackHost(req: IncomingMessage): boolean {
  const host = req.headers.host ?? '';
  const at = host.lastIndexOf(':');
  if (at <= 0) return false;
  return LOOPBACK.has(host.slice(0, at)) && host.slice(at + 1) === String(req.socket.localPort);
}

/** JSON-RPC 한 통. 알림이면 null(202). 토큰은 본문을 다 읽은 뒤 다시 찾는다: 그사이 회수됐을 수 있다 */
function rpc(msg: unknown, port: () => LeadPort | undefined): object | null {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return rpcError(null, -32600, 'invalid request');
  const { id, method, params } = msg as Json;
  if (typeof method !== 'string') return rpcError(id, -32600, 'invalid request');
  if (id === undefined) return null;
  const p = (params && typeof params === 'object' ? params : {}) as Json;
  switch (method) {
    case 'initialize':
      return rpcOk(id, { protocolVersion: isStr(p.protocolVersion) ? p.protocolVersion : '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: SERVER, version: '1' } });
    case 'ping': return rpcOk(id, {});
    case 'tools/list': return rpcOk(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === p.name);
      if (!tool) return rpcError(id, -32602, `없는 도구예요: ${String(p.name)}`);
      const parsed = tool.parse((p.arguments && typeof p.arguments === 'object' ? p.arguments : {}) as Json);
      if (typeof parsed === 'string') return rpcOk(id, toolText(parsed, true));
      const run = port();
      if (!run) return rpcOk(id, toolText('이 연결은 이미 끝났어요.', true));
      const r = run(parsed);
      return rpcOk(id, r.ok ? toolText(r.text ?? '됐어요.', false) : toolText(r.error, true));
    }
    default: return rpcError(id, -32601, 'method not found');
  }
}
