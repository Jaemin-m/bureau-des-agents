import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { SessionSpec, WorkerSignal } from '../server/agents/adapter.ts';
import { claudeAdapter, claudeArgv, claudeMapper } from '../server/agents/claude.ts';
import { childEnv } from '../server/agents/env.ts';
import { adapterFor } from '../server/agents/registry.ts';
import { fakeClaude, type Step } from './support/fake-claude.ts';

const FIXTURES = new URL('./fixtures/claude-2.1.322/', import.meta.url);
const stdout = (name: string) => readFileSync(new URL(`${name}.raw.jsonl`, FIXTURES), 'utf8').split('\n').filter(Boolean)
  .map((l) => JSON.parse(l) as { dir: string; line: string }).filter((r) => r.dir === 'stdout').map((r) => JSON.parse(r.line) as Record<string, any>);

const spec = (over: Partial<SessionSpec> = {}): SessionSpec => ({
  cwd: '/work/mission', powers: { tools: ['Read', 'Write', 'Bash'], preapproved: ['Read'] }, access: 'write', autonomy: 'auto', systemPrompt: '지시문', ...over,
});

const FIXED = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio'];

test('옵션: 표', () => {
  const cases: { name: string; spec: SessionSpec; team?: string; want: string[] }[] = [
    {
      name: '쓰기, 알아서',
      spec: spec(),
      want: [...FIXED, '--permission-mode', 'auto', '--restricted', '--tools', 'Read,Write,Bash', '--append-system-prompt', '지시문', '--allowedTools', 'Read', '--disallowedTools', 'AskUserQuestion'],
    },
    {
      name: '읽기 전용이면 쓰는 도구와 명령이 빠진다',
      spec: spec({ access: 'read', powers: { tools: ['Read', 'Write', 'Edit', 'Bash', 'WebFetch'], preapproved: [] } }),
      want: [...FIXED, '--permission-mode', 'auto', '--restricted', '--tools', 'Read,WebFetch', '--append-system-prompt', '지시문', '--disallowedTools', 'AskUserQuestion'],
    },
    {
      name: '묻기는 acceptEdits, 모델과 이어가기',
      spec: spec({ autonomy: 'ask', model: 'haiku', resume: { id: 'sess-1', cwd: '/work/mission' } }),
      want: [...FIXED, '--permission-mode', 'acceptEdits', '--restricted', '--tools', 'Read,Write,Bash', '--append-system-prompt', '지시문', '--model', 'haiku', '--resume', 'sess-1', '--allowedTools', 'Read', '--disallowedTools', 'AskUserQuestion'],
    },
    {
      name: 'MCP는 설정과 엄격 모드가 따로다',
      spec: spec({ mcpConfig: '{"mcpServers":{}}', strictMcp: true, powers: { tools: ['Read'], preapproved: ['mcp__office__*'] } }),
      want: [...FIXED, '--permission-mode', 'auto', '--restricted', '--tools', 'Read', '--append-system-prompt', '지시문', '--allowedTools', 'mcp__office__*', '--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config', '--disallowedTools', 'AskUserQuestion'],
    },
    {
      name: '엄격 모드만 주면 사용자의 커넥터가 모두 빠진다',
      spec: spec({ strictMcp: true, powers: { tools: [], preapproved: [] } }),
      want: [...FIXED, '--permission-mode', 'auto', '--restricted', '--tools', '', '--append-system-prompt', '지시문', '--strict-mcp-config', '--disallowedTools', 'AskUserQuestion'],
    },
    {
      name: '레거시 팀장: 팀은 도구 뒤, 지시문 앞',
      spec: spec(),
      team: '{"a":1}',
      want: [...FIXED, '--permission-mode', 'auto', '--restricted', '--tools', 'Read,Write,Bash', '--agents', '{"a":1}', '--append-system-prompt', '지시문', '--allowedTools', 'Read', '--disallowedTools', 'AskUserQuestion'],
    },
  ];
  for (const c of cases) assert.deepEqual(claudeArgv(c.spec, c.team), c.want, c.name);
});

test('환경: API 키는 기본으로 빠지고, 켜면 남고, 원본은 그대로다', () => {
  const base = { PATH: '/bin', ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', OPENAI_API_KEY: 'o' };
  assert.deepEqual(childEnv('claude', base, false), { PATH: '/bin', OPENAI_API_KEY: 'o', BUREAU_DES_AGENTS: '1' });
  assert.deepEqual(childEnv('claude', base, true), { ...base, BUREAU_DES_AGENTS: '1' });
  assert.equal(childEnv('codex', base, false).OPENAI_API_KEY, undefined);
  assert.equal(base.ANTHROPIC_API_KEY, 'k');
});

test('registry: codex와 gemini는 아직 없다고 답하고 열리지 않는다', async () => {
  for (const kind of ['codex', 'gemini'] as const) {
    const probe = await adapterFor(kind).probe();
    assert.equal(probe.found, false);
    assert.match(probe.note ?? '', /아직/);
    assert.throws(() => adapterFor(kind).open(spec(), { text: 'x' }, () => {}), /아직/);
  }
});

// ── 줄 → 신호(녹화한 진짜 스트림) ──

function mapAll(name: string, cwd = '/work/mission') {
  const mapper = claudeMapper(cwd, () => 1000);
  return stdout(name).flatMap((m) => mapper.feed(m));
}
const kinds = (s: WorkerSignal[]) => s.map((x) => x.k);

test('매퍼: 허락 요청 한 번 왕복', () => {
  const signals = mapAll('permission', '<TMP>/claude-permission');
  const approvals = signals.filter((s) => s.k === 'approval');
  assert.deepEqual(approvals, [{
    k: 'approval', id: 'e2706312-4eae-44ea-aa7e-6aeccc4f2389', tool: 'Write', label: 'hello.txt 작성해도 될까요?',
    detail: '<TMP>/claude-permission/hello.txt', full: true,
  }]);
  const ends = signals.filter((s) => s.k === 'turn_end');
  assert.deepEqual(ends, [{ k: 'turn_end', text: 'done', ok: true, interrupted: false }]);
  assert.equal(signals.find((s) => s.k === 'session')?.k, 'session');
  assert.ok(kinds(signals).indexOf('approval') < kinds(signals).indexOf('turn_end'));
  assert.ok(signals.some((s) => s.k === 'act' && s.tool === 'Write'));
  assert.ok(signals.some((s) => s.k === 'quota' && s.fiveHour >= 0));
});

test('매퍼: 중단은 턴을 interrupted로 끝내고, 같은 프로세스의 다음 턴은 정상이다', () => {
  const signals = mapAll('interrupt');
  const ends = signals.filter((s) => s.k === 'turn_end');
  assert.equal(ends.length, 2);
  assert.deepEqual(ends[0], { k: 'turn_end', text: ends[0].k === 'turn_end' ? ends[0].text : '', ok: false, interrupted: true, error: 'error_during_execution' });
  assert.deepEqual(ends[1], { k: 'turn_end', text: 'ALIVE', ok: true, interrupted: false });
  // 턴마다 init이 다시 오고, 세션은 그대로다
  const sessions = signals.filter((s) => s.k === 'session');
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions[0], sessions[1]);
});

test('매퍼: 턴 도중에 보낸 메시지는 큐에 쌓여 자기 턴과 자기 결과를 가진다', () => {
  const signals = mapAll('midturn-stdin');
  const ends = signals.filter((s): s is Extract<WorkerSignal, { k: 'turn_end' }> => s.k === 'turn_end');
  assert.equal(ends.length, 2);
  assert.match(ends[0].text, /^1\n2\n3/);
  assert.deepEqual(ends[1], { k: 'turn_end', text: 'SECOND-MESSAGE-RECEIVED', ok: true, interrupted: false });
  // 턴마다 usage가 turn_end 바로 앞에 온다
  const ks = kinds(signals);
  ks.forEach((k, i) => { if (k === 'turn_end') assert.equal(ks[i - 1], 'usage'); });
});

test('매퍼: 모르는 줄과 허락 아닌 제어 요청은 신호가 없고, 거둬들인 요청만 취소된다', () => {
  const mapper = claudeMapper('/work/mission', () => 1000);
  const ask = { type: 'control_request', request_id: 'a1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'ls' } } };
  assert.deepEqual(mapper.feed({ type: 'control_request', request_id: 'h1', request: { subtype: 'hook_callback' } }), []);
  assert.deepEqual(mapper.feed({ type: 'whatever' }), []);
  assert.deepEqual(mapper.feed({ type: 'control_cancel_request', request_id: 'a1' }), []);
  assert.equal(mapper.feed(ask)[0].k, 'approval');
  assert.deepEqual(mapper.feed({ type: 'control_cancel_request', request_id: 'a1' }), [{ k: 'approval_cancelled', id: 'a1' }]);
});

test('매퍼: 글 쓰는 중 신호는 120ms마다 한 번', () => {
  let t = 1000;
  const mapper = claudeMapper('/work/mission', () => t);
  const delta = (text: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } });
  assert.deepEqual(mapper.feed({ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'text' } } }), []);
  assert.deepEqual(mapper.feed(delta('안')), [{ k: 'typing', text: '안' }]);
  t += 50;
  assert.deepEqual(mapper.feed(delta('녕')), []);
  t += 100;
  assert.deepEqual(mapper.feed(delta('!')), [{ k: 'typing', text: '안녕!' }]);
});

// ── 프로세스 껍데기(가짜 claude) ──

const line = (o: unknown) => JSON.stringify(o);
const init = line({ type: 'system', subtype: 'init', session_id: 's-1', model: 'fake-model', apiKeySource: 'none' });
const result = (text: string) => line({ type: 'result', subtype: 'success', is_error: false, result: text, duration_ms: 5, usage: { input_tokens: 3, output_tokens: 4 } });
const written = (file: string) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

function open(steps: Step[], over: Partial<SessionSpec> = {}) {
  const fake = fakeClaude(steps);
  const signals: WorkerSignal[] = [];
  const waiting: { pred: (s: WorkerSignal[]) => boolean; resolve: () => void }[] = [];
  const session = claudeAdapter.open(spec({ cwd: mkdtempSync(path.join(os.tmpdir(), 'bureau-adapter-')), ...over }), { text: '첫 말' }, (s) => {
    signals.push(s);
    for (const w of waiting.filter((x) => x.pred(signals))) { waiting.splice(waiting.indexOf(w), 1); w.resolve(); }
  });
  const until = (pred: (s: WorkerSignal[]) => boolean) => new Promise<void>((resolve) => {
    if (pred(signals)) resolve(); else waiting.push({ pred, resolve });
  });
  const has = (k: WorkerSignal['k'], n = 1) => until((s) => s.filter((x) => x.k === k).length >= n);
  return { fake, session, signals, has, until };
}

test('껍데기: 허락 요청에 답하면 control_response가 가고, 모르는 요청 번호는 무시한다', async () => {
  const ask = line({ type: 'control_request', request_id: 'r-1', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: '/x/a.txt', content: 'hi' }, tool_use_id: 't1' } });
  const o = open([{ waitIn: 1 }, { emit: [init, ask] }, { waitIn: 2 }, { emit: [result('끝')] }]);
  await o.has('approval');
  o.session.answerApproval('없는-번호', true);
  o.session.answerApproval('r-1', true);
  await o.has('turn_end');
  assert.deepEqual(written(o.fake.inFile)[1], { type: 'control_response', response: { subtype: 'success', request_id: 'r-1', response: { behavior: 'allow', updatedInput: { file_path: '/x/a.txt', content: 'hi' } } } });
  assert.equal(written(o.fake.inFile).length, 2);
  o.session.kill();
});

test('껍데기: 거절은 deny와 이유를 보낸다', async () => {
  const ask = line({ type: 'control_request', request_id: 'r-2', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf x' } } });
  const o = open([{ waitIn: 1 }, { emit: [init, ask] }, { waitIn: 2 }, { emit: [result('')] }]);
  await o.has('approval');
  o.session.answerApproval('r-2', false);
  await o.has('turn_end');
  const reply = written(o.fake.inFile)[1];
  assert.equal(reply.response.response.behavior, 'deny');
  assert.match(reply.response.response.message, /허락하지 않았어요/);
  o.session.kill();
});

test('껍데기: interrupt는 control_request를 보내고 턴은 interrupted로 끝나며 프로세스는 산다', async () => {
  const aborted = line({ type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', result: null });
  const o = open([{ waitIn: 1 }, { emit: [init] }, { waitIn: 2 }, { emit: [aborted] }, { waitIn: 3 }, { emit: [init, result('ALIVE')] }]);
  await o.has('session');
  o.session.interrupt();
  await o.has('turn_end');
  assert.equal(written(o.fake.inFile)[1].request.subtype, 'interrupt');
  assert.deepEqual(o.signals.filter((s) => s.k === 'turn_end'), [{ k: 'turn_end', text: '', ok: false, interrupted: true, error: 'error_during_execution' }]);
  assert.equal(o.session.alive, true);
  o.session.send({ text: '다시' }, 'turn');
  await o.has('turn_end', 2);
  assert.deepEqual(o.signals.filter((s) => s.k === 'turn_end')[1], { k: 'turn_end', text: 'ALIVE', ok: true, interrupted: false });
  o.session.kill();
});

test('껍데기: 턴 도중에 보낸 메시지는 순서대로 자기 turn_end를 가진다', async () => {
  const o = open([{ waitIn: 1 }, { emit: [init, result('첫째')] }, { waitIn: 2 }, { emit: [init, result('둘째')] }]);
  o.session.send({ text: '둘째 말' }, 'turn');
  await o.has('turn_end', 2);
  assert.deepEqual(o.signals.filter((s) => s.k === 'turn_end').map((s) => s.k === 'turn_end' && s.text), ['첫째', '둘째']);
  assert.deepEqual(written(o.fake.inFile).map((m) => m.message.content[0].text), ['첫 말', '둘째 말']);
  o.session.kill();
});

test('껍데기: 끼어들기(steer)는 던진다', async () => {
  const o = open([{ waitIn: 1 }, { emit: [init] }]);
  assert.throws(() => o.session.send({ text: 'x' }, 'steer'), /끼어들 수 없어요/);
  o.session.kill();
});

test('껍데기: 읽을 수 없는 줄은 diag, 빈 줄은 건너뛴다', async () => {
  const o = open([{ waitIn: 1 }, { emit: ['', '배너: 안녕', init] }]);
  await o.has('session');
  assert.deepEqual(o.signals.filter((s) => s.k === 'diag'), [{ k: 'diag', line: '배너: 안녕' }]);
  o.session.kill();
});

test('껍데기: 턴 도중에 프로세스가 죽으면 turn_end(실패) 하나 뒤에 exit가 온다', async () => {
  const o = open([{ waitIn: 1 }, { emit: [init] }, { exit: 3 }]);
  await o.has('exit');
  const ks = kinds(o.signals);
  assert.deepEqual(ks.slice(-2), ['turn_end', 'exit']);
  assert.equal(ks.filter((k) => k === 'turn_end').length, 1);
  const end = o.signals.find((s) => s.k === 'turn_end');
  assert.equal(end?.k === 'turn_end' && end.ok, false);
  const exit = o.signals.at(-1);
  assert.equal(exit?.k === 'exit' && exit.code, 3);
  assert.equal(exit?.k === 'exit' && exit.expected, false);
  assert.throws(() => o.session.send({ text: 'x' }, 'turn'), /이미 끝났어요/);
});

test('껍데기: kill 뒤에는 exit 하나 말고 아무 신호도 없다', async () => {
  const o = open([{ waitIn: 1 }, { emit: [init] }, { waitIn: 2 }, { emit: [result('늦은 답')] }]);
  await o.has('session');
  o.session.kill();
  await o.has('exit');
  const after = o.signals.slice(o.signals.findIndex((s) => s.k === 'session') + 1);
  assert.deepEqual(after.map((s) => s.k), ['exit']);
  assert.equal(after[0].k === 'exit' && after[0].expected, true);
});

test('껍데기: park는 입력을 닫고 프로세스가 사라지면 끝난다', async () => {
  const o = open([{ waitIn: 1 }, { emit: [init, result('끝')] }]);
  await o.has('turn_end');
  await o.session.park();
  assert.equal(o.session.alive, false);
  const exit = o.signals.at(-1);
  assert.deepEqual(exit && exit.k === 'exit' && [exit.code, exit.expected], [0, true]);
});

test('껍데기: 멈추면 프로세스 그룹 전체가 멈춘다', async () => {
  const pidFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'bureau-group-')), 'child.pid');
  const o = open([{ waitIn: 1 }, { child: pidFile }, { emit: [init] }]);
  await o.has('session');
  const child = Number(readFileSync(pidFile, 'utf8'));
  assert.doesNotThrow(() => process.kill(child, 0));
  o.session.kill();
  await o.has('exit');
  for (let i = 0; i < 100 && alive(child); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(alive(child), false, '하위 프로세스도 멈춰야 해요');
  assert.ok(existsSync(pidFile));
});

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('probe: CLAUDE_BIN이 가리키는 실행 파일의 버전과 능력', async () => {
  fakeClaude([]);
  const probe = await claudeAdapter.probe();
  assert.equal(probe.found, true);
  assert.equal(probe.version, '9.9.9');
  assert.deepEqual(probe.caps, { approvals: true, steer: false, liveSession: true, web: true, hostTools: true });
});
