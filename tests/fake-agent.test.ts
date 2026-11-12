// 가짜 에이전트가 녹화한 진짜 줄과 같은 모양을 내는지, 그리고 대본의 단계가 약속대로 움직이는지 본다.
// 어댑터를 거치지 않고 실행 파일을 직접 띄운다(어댑터와 함께 도는 시험은 claude-adapter.test.ts).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fakeAgents, turn, type Kind, type ScriptInput } from './support/fake-agent.ts';
import { recorded, type Json } from './support/fake-agent-lines.ts';

const tmpDir = (name: string) => realpathSync(mkdtempSync(path.join(os.tmpdir(), `${name}-`)));

/** 가짜 실행 파일을 직접 띄운다. 줄은 나오는 대로 모은다. */
function spawnFake(bin: string, args: string[], cwd: string) {
  const p = spawn(bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines: string[] = [];
  const waiting: { pred: () => boolean; resolve: () => void }[] = [];
  let buf = '';
  let stderr = '';
  p.stdout.setEncoding('utf8').on('data', (d: string) => {
    buf += d;
    let n: number;
    while ((n = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, n)); buf = buf.slice(n + 1); }
    for (const w of waiting.filter((x) => x.pred())) { waiting.splice(waiting.indexOf(w), 1); w.resolve(); }
  });
  p.stderr.setEncoding('utf8').on('data', (d: string) => { stderr += d; });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => p.on('close', (code, signal) => resolve({ code, signal })));
  return {
    p, lines, exited, stderr: () => stderr,
    json: () => lines.map((l) => JSON.parse(l) as Json),
    send: (o: unknown) => p.stdin.write(`${typeof o === 'string' ? o : JSON.stringify(o)}\n`),
    end: () => p.stdin.end(),
    until: (pred: (l: string[]) => boolean) => new Promise<void>((resolve) => {
      if (pred(lines)) resolve(); else waiting.push({ pred: () => pred(lines), resolve });
    }),
  };
}

const userLine = (text: string) => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } });

// ── 줄의 종류와 모양 ──

/** 줄 하나가 무슨 줄인지: 형식, 부형식, 스트림 이벤트와 그 조각의 종류까지 */
function kindOf(m: Json): string {
  const e = m.event;
  return [m.type, m.subtype, e?.type, e?.delta?.type, e?.delta?.stop_reason, e?.content_block?.type].filter(Boolean).join('/') || m.type;
}

/** 키 구조만(값과 배열 안쪽은 보지 않는다) */
function shape(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape((v as Json)[k])]));
  return Array.isArray(v) ? '[]' : 'v';
}

const dedupe = (xs: string[]) => xs.filter((x, i) => x !== xs[i - 1]);

const CLAUDE_FIXTURES = ['permission', 'mcp-http', 'interrupt'].map((n) => `claude-2.1.322/${n}.raw`);
const recordedShapes = new Map<string, Set<string>>();
for (const f of CLAUDE_FIXTURES) {
  for (const m of recorded(f, 'stdout')) {
    const set = recordedShapes.get(kindOf(m)) ?? new Set<string>();
    set.add(JSON.stringify(shape(m)));
    recordedShapes.set(kindOf(m), set);
  }
}

function assertRecordedShapes(lines: Json[]) {
  for (const m of lines) {
    const known = recordedShapes.get(kindOf(m));
    assert.ok(known, `녹화에 없는 줄 종류예요: ${kindOf(m)}`);
    assert.ok(known.has(JSON.stringify(shape(m))), `${kindOf(m)}의 모양이 녹화와 달라요: ${JSON.stringify(shape(m))}`);
  }
}

const fixtureKinds = (name: string, skip: string[] = []) => dedupe(recorded(name, 'stdout').map(kindOf).filter((k) => !skip.includes(k)));

// ── claude ──

test('claude: 허락을 묻는 턴은 녹화(permission)와 같은 줄을 같은 순서로 낸다', async () => {
  const cwd = tmpDir('fake-claude-permission');
  const input = { file_path: '{{cwd}}/hello.txt', content: 'hello from the probe' };
  const fakes = fakeAgents({ claude: turn({ approval: { tool: 'Write', input, expect: 'allow' } }, { writeFile: { path: 'hello.txt', content: 'hello from the probe' } }, { say: { text: 'done' } }) });
  const f = spawnFake(fakes.bin.claude, ['-p', '--model', 'haiku', '--tools', 'Write,Read', '--permission-mode', 'manual'], cwd);
  f.send(userLine('hello.txt를 만들어 주세요'));
  await f.until((l) => l.some((x) => x.includes('"control_request"')));
  const ask = f.json().find((m) => m.type === 'control_request')!;
  assert.equal(ask.request.input.file_path, `${cwd}/hello.txt`);
  f.send({ type: 'control_response', response: { subtype: 'success', request_id: ask.request_id, response: { behavior: 'allow', updatedInput: ask.request.input } } });
  await f.until((l) => l.some((x) => x.includes('"type":"result"')));

  assert.deepEqual(dedupe(f.json().map(kindOf)), fixtureKinds('claude-2.1.322/permission.raw', ['system/commands_changed']));
  assertRecordedShapes(f.json());
  assert.equal(readFileSync(path.join(cwd, 'hello.txt'), 'utf8'), 'hello from the probe');
  assert.deepEqual(f.json().find((m) => m.type === 'result')?.result, 'done');
  f.end();
  assert.deepEqual(await f.exited, { code: 0, signal: null });
  fakes.assertClean();
});

test('claude: 중단은 녹화(interrupt)처럼 답하고, 같은 프로세스에서 다음 턴이 이어진다', async () => {
  const cwd = tmpDir('fake-claude-interrupt');
  const fakes = fakeAgents({ claude: [...turn({ interrupt: { partial: '1\n2' } }), ...turn({ say: { text: 'ALIVE' } })] });
  const f = spawnFake(fakes.bin.claude, ['-p'], cwd);
  f.send(userLine('1부터 500까지'));
  await f.until((l) => l.some((x) => x.includes('text_delta')));
  f.send({ type: 'control_request', request_id: 'stop-1', request: { subtype: 'interrupt' } });
  await f.until((l) => l.some((x) => x.includes('aborted_streaming')));
  const ack = f.json().find((m) => m.type === 'control_response')!;
  assert.deepEqual(ack.response, { subtype: 'success', request_id: 'stop-1', response: { still_queued: [] } });
  const aborted = f.json().find((m) => m.type === 'result')!;
  assert.deepEqual([aborted.is_error, aborted.subtype, aborted.terminal_reason], [true, 'error_during_execution', 'aborted_streaming']);

  f.send(userLine('Reply with exactly: ALIVE'));
  await f.until((l) => l.filter((x) => x.includes('"type":"result"')).length === 2);
  assert.equal(f.json().filter((m) => m.type === 'result')[1].result, 'ALIVE');
  assert.equal(f.json().filter((m) => m.subtype === 'init').length, 2);
  assertRecordedShapes(f.json());
  assert.deepEqual(new Set(f.json().map((m) => m.session_id).filter(Boolean)).size, 1);
  f.end();
  assert.deepEqual(await f.exited, { code: 0, signal: null });
  fakes.assertClean();
});

/** 녹화한 서버(mcp-http.server)가 하던 일을 하는 아주 작은 MCP 서버 */
function miniMcp() {
  const seen: { method: string; auth: string | undefined; body: Json }[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      const body = JSON.parse(raw) as Json;
      seen.push({ method: body.method, auth: req.headers.authorization, body });
      if (body.id === undefined) { res.writeHead(202).end(); return; }
      const result: Record<string, () => Json> = {
        initialize: () => ({ protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'office-probe', version: '0.0.1' } }),
        'tools/list': () => ({ tools: [{ name: 'office_ping', description: 'pong', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } }] }),
        'tools/call': () => ({ content: [{ type: 'text', text: `PONG-7731:${body.params.arguments.message}` }] }),
      };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: result[body.method]() }));
    });
  });
  return new Promise<{ url: string; seen: typeof seen; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`, seen, close: () => server.close() }));
  });
}

test('claude: 팀장이 MCP 도구를 부르면 녹화(mcp-http)와 같은 줄과 같은 요청이 나간다', async () => {
  const mcp = await miniMcp();
  const cwd = tmpDir('fake-claude-mcp');
  const config = JSON.stringify({ mcpServers: { office: { type: 'http', url: mcp.url, headers: { Authorization: 'Bearer tok-1' } } } });
  const fakes = fakeAgents({ claude: turn({ mcp: { tool: 'office_ping', args: { message: 'hello' }, saveAs: 'pong', expectResult: '^PONG-7731' } }, { say: { text: '{{var.pong}}' } }) });
  const f = spawnFake(fakes.bin.claude, ['-p', '--tools', 'Read', '--allowedTools', 'mcp__office__office_ping', '--mcp-config', config, '--strict-mcp-config'], cwd);
  f.send(userLine('office_ping을 한 번 부르세요'));
  await f.until((l) => l.some((x) => x.includes('"type":"result"')));
  f.end();
  await f.exited;
  mcp.close();

  const init = f.json().find((m) => m.subtype === 'init')!;
  assert.deepEqual(init.mcp_servers, [{ name: 'office', status: 'connected', source: 'dynamic' }]);
  assert.deepEqual(init.tools, ['Read', 'mcp__office__office_ping']);
  assert.deepEqual(dedupe(f.json().map(kindOf)), fixtureKinds('claude-2.1.322/mcp-http.raw'));
  assertRecordedShapes(f.json());
  assert.equal(f.json().find((m) => m.type === 'result')?.result, 'PONG-7731:hello');

  const recordedReq = recorded('claude-2.1.322/mcp-http.server', 'req').map((r) => r.body as Json | undefined).filter((b): b is Json => !!b && b.method !== 'server/discover');
  assert.deepEqual(mcp.seen.map((s) => s.method), recordedReq.map((b) => b.method));
  assert.deepEqual(mcp.seen.map((s) => shape(s.body)), recordedReq.map((b) => shape(b)));
  assert.ok(mcp.seen.every((s) => s.auth === 'Bearer tok-1'));
  const call = mcp.seen.at(-1)!.body;
  const toolUse = f.json().find((m) => m.type === 'assistant' && m.message.content[0].type === 'tool_use')!.message.content[0];
  assert.deepEqual([call.params.name, call.params.arguments, call.params._meta['claudecode/toolUseId']], ['office_ping', { message: 'hello' }, toolUse.id]);
  assert.equal(toolUse.name, 'mcp__office__office_ping');
  fakes.assertClean();
});

// ── codex ──

const codexMeta = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/codex-0.167.1/${name}.meta.json`, import.meta.url), 'utf8')) as { argv: string[]; threadId: string };
const codexRaw = (name: string) => readFileSync(new URL(`./fixtures/codex-0.167.1/${name}.raw.jsonl`, import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { dir: string; line: string });
const codexOut = (name: string) => codexRaw(name).filter((r) => r.dir === 'stdout').map((r) => r.line);
const codexPrompt = (name: string) => codexRaw(name).find((r) => r.dir === 'stdin')!.line;
const codexUsage = (name: string) => JSON.parse(codexOut(name).at(-1)!).usage as Json;

test('codex: 첫 턴과 resume이 녹화(codex-0.167.1)와 같은 줄을 낸다', async () => {
  const cwd = tmpDir('fake-codex');
  const first = codexMeta('first-turn');
  const resume = codexMeta('resume');
  const fakes = fakeAgents({
    codex: {
      launches: [
        {
          thread: first.threadId,
          steps: [
            { expectInput: { stdin: 'hello\\.txt', argv: '^exec --json' } }, { begin: true },
            { command: { run: `/bin/zsh -lc "printf 'hello from codex.' > hello.txt"` } },
            { writeFile: { path: 'hello.txt', content: 'hello from codex.' } },
            { say: { text: 'done', usage: codexUsage('first-turn') } },
          ],
        },
        // 이어가기는 자기 대본 칸을 쓰고, 스레드 번호는 옵션의 `resume <id>`에서 온다
        { steps: [{ expectInput: { stdin: 'second', argv: `^exec resume ${resume.threadId} --json` } }, { begin: true }, { say: { text: 'I can’t append to `hello.txt` because the current filesystem is read-only.', usage: codexUsage('resume') } }] },
      ],
    },
  });
  const argvOf = (meta: { argv: string[] }) => meta.argv.slice(1).map((a) => a.replace('<TMP>/codex-first-turn', cwd));

  const a = spawnFake(fakes.bin.codex, argvOf(first), cwd);
  a.send(codexPrompt('first-turn'));
  a.end();
  assert.deepEqual(await a.exited, { code: 0, signal: null });
  assert.deepEqual(a.lines, codexOut('first-turn'));
  assert.equal(readFileSync(path.join(cwd, 'hello.txt'), 'utf8'), 'hello from codex.');

  const b = spawnFake(fakes.bin.codex, argvOf(resume), cwd);
  b.send(codexPrompt('resume'));
  b.end();
  assert.deepEqual(await b.exited, { code: 0, signal: null });
  assert.deepEqual(b.lines, codexOut('resume'));
  assert.deepEqual(fakes.launches('codex').map((l) => [l.index, l.stdin]), [[0, [`${codexPrompt('first-turn')}\n`]], [1, [`${codexPrompt('resume')}\n`]]]);
  fakes.assertClean();
});

// ── 단계의 약속 ──

async function runOnce(kind: Kind, script: ScriptInput, argv: string[], input?: string) {
  const fakes = fakeAgents({ [kind]: script });
  const cwd = tmpDir('fake-once');
  const f = spawnFake(fakes.bin[kind], argv, cwd);
  if (input !== undefined) f.send(input);
  f.end();
  return { fakes, cwd, f, exit: await f.exited };
}

test('어긋난 대본은 종료 코드 99와 failure로 시끄럽게 실패한다', async () => {
  const cases: { name: string; kind: Kind; script: ScriptInput; why: RegExp }[] = [
    { name: '입력이 기대와 다르다', kind: 'claude', script: [{ expectInput: '안녕' }], why: /expectInput.*안녕/ },
    { name: '옵션이 기대와 다르다', kind: 'claude', script: [{ expectInput: { argv: '--resume' } }], why: /옵션이/ },
    { name: '쓸 대본 칸이 없다', kind: 'claude', script: { launches: [] }, why: /대본 칸이 없어요/ },
    { name: '작업 폴더 밖에는 쓰지 않는다', kind: 'claude', script: [{ expectInput: {} }, { writeFile: { path: '../밖.txt', content: 'x' } }], why: /작업 폴더 밖/ },
    { name: 'claude에 없는 단계(codex의 명령)', kind: 'claude', script: turn({ command: { run: 'ls' } }), why: /codex에서만/ },
    { name: 'codex에는 승인이 없다', kind: 'codex', script: turn({ approval: { tool: 'Bash', input: {}, expect: 'allow' } }), why: /claude에서만/ },
    { name: 'begin 없이 말하면', kind: 'claude', script: [{ expectInput: {} }, { say: { text: 'x' } }], why: /begin/ },
    { name: '모르는 단계', kind: 'claude', script: [{ nope: 1 } as never], why: /알 수 없는 단계/ },
  ];
  await Promise.all(cases.map(async (c) => {
    const r = await runOnce(c.kind, c.script, c.kind === 'codex' ? ['exec', '--json', '-'] : ['-p'], c.kind === 'codex' ? '프롬프트' : JSON.stringify(userLine('첫 말')));
    assert.equal(r.exit.code, 99, c.name);
    assert.match(r.fakes.launches(c.kind)[0].failure ?? '', c.why, c.name);
    assert.match(r.f.stderr(), /fake-agent:/, c.name);
    assert.throws(() => r.fakes.assertClean(), /어긋났어요/, c.name);
  }));
});

test('칸의 match는 옵션과 첫 입력으로 일꾼을 가린다, 같은 칸을 두 번 쓰지 않는다', async () => {
  const fakes = fakeAgents({
    claude: {
      launches: [
        { match: '\\[fake:b\\]', steps: turn({ say: { text: '나는 B' } }) },
        { match: '--resume', steps: turn({ say: { text: '이어가기' } }) },
        { steps: turn({ say: { text: '나머지' } }) },
      ],
    },
  });
  const ask = async (argv: string[], text: string) => {
    const f = spawnFake(fakes.bin.claude, argv, tmpDir('fake-route'));
    f.send(userLine(text));
    await f.until((l) => l.some((x) => x.includes('"type":"result"')));
    f.end();
    await f.exited;
    return f.json().find((m) => m.type === 'result')?.result;
  };
  assert.equal(await ask(['-p'], '일 [fake:a]'), '나머지');
  assert.equal(await ask(['-p'], '일 [fake:b]'), '나는 B');
  assert.equal(await ask(['-p', '--resume', 's-9'], '다시'), '이어가기');
  fakes.assertClean();
  const f = spawnFake(fakes.bin.claude, ['-p'], tmpDir('fake-route'));
  f.send(userLine('넷째'));
  f.end();
  assert.equal((await f.exited).code, 99);
  assert.deepEqual(fakes.launches('claude').map((l) => l.index), [0, 1, 2, 3]);
});

test('resume 옵션의 번호가 세션과 스레드 번호가 되고, 자리표시자와 saveAs가 채워진다', async () => {
  const claude = await runOnce('claude', turn({ say: { text: '세션 {{session}} 폴더 {{cwd}} 번호 {{launch}}' } }), ['-p', '--resume', 's-42'], JSON.stringify(userLine('x')));
  const said = claude.f.json().find((m) => m.type === 'result')!.result as string;
  assert.equal(said, `세션 s-42 폴더 ${claude.cwd} 번호 0`);
  assert.equal(new Set(claude.f.json().map((m) => m.session_id).filter(Boolean)).size, 1);
  assert.equal(claude.f.json()[0].session_id, 's-42');

  const codex = await runOnce('codex', turn({ say: { text: '스레드 {{thread}}' } }), ['exec', 'resume', 't-7', '--json', '-'], '프롬프트');
  assert.equal(JSON.parse(codex.f.lines[0]).thread_id, 't-7');
  assert.equal(JSON.parse(codex.f.lines[2]).item.text, '스레드 t-7');
});

test('handback은 마지막 답 끝에 ```handback 블록을 붙인다', async () => {
  const block = { status: 'done', summary: '다 했어요', files: ['a.txt'] };
  const r = await runOnce('claude', turn({ handback: { text: '끝났어요.', block } }), ['-p'], JSON.stringify(userLine('x')));
  const text = r.f.json().find((m) => m.type === 'result')!.result as string;
  assert.equal(text, `끝났어요.\n\n\`\`\`handback\n${JSON.stringify(block)}\n\`\`\``);
});

test('exit, crash, hang: 끝나는 방식이 다르다', async () => {
  const cwd = tmpDir('fake-end');
  const fakes = fakeAgents({ claude: { launches: [turn({ exit: 7 }), turn({ crash: true }), turn({ hang: true })] } });
  const run = async () => {
    const f = spawnFake(fakes.bin.claude, ['-p'], cwd);
    f.send(userLine('x'));
    return f;
  };
  const a = await run();
  assert.deepEqual(await a.exited, { code: 7, signal: null });
  assert.ok(!a.lines.some((l) => l.includes('"type":"result"')), 'exit도 턴을 끝내는 줄은 없다');

  const b = await run();
  assert.deepEqual(await b.exited, { code: null, signal: 'SIGKILL' });
  assert.ok(!b.lines.some((l) => l.includes('"type":"result"')));

  const c = await run();
  await c.until((l) => l.some((x) => x.includes('"subtype":"init"')));
  c.end();
  const early = await Promise.race([c.exited, new Promise((r) => setTimeout(() => r('살아 있어요'), 300))]);
  assert.equal(early, '살아 있어요', '입력을 닫아도 hang은 끝나지 않는다');
  c.p.kill('SIGTERM');
  assert.deepEqual(await c.exited, { code: null, signal: 'SIGTERM' });
  fakes.assertClean();
});

test('wait, expectControl, 제어 줄과 사용자 줄은 따로 센다', async () => {
  const t0 = Date.now();
  const fakes = fakeAgents({ claude: [{ expectInput: {} }, { expectControl: 2 }, { wait: 120 }, { begin: true }, { say: { text: '둘 받았어요' } }] });
  const f = spawnFake(fakes.bin.claude, ['-p'], tmpDir('fake-wait'));
  f.send(userLine('x'));
  f.send({ type: 'control_response', response: { subtype: 'error', request_id: 'a', error: 'no' } });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(f.lines.length, 0, '제어 줄이 하나 모자라면 기다린다');
  f.send({ type: 'control_response', response: { subtype: 'error', request_id: 'b', error: 'no' } });
  await f.until((l) => l.some((x) => x.includes('"type":"result"')));
  assert.ok(Date.now() - t0 >= 120);
  f.end();
  await f.exited;
  assert.equal(existsSync(path.join(fakes.dir, 'claude', 'launch-0', 'failure.txt')), false);
});
