import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { SessionSpec, WorkerSignal } from '../server/agents/adapter.ts';
import { bareCommand, codexAdapter, codexArgv, codexMapper, codexPrompt } from '../server/agents/codex.ts';
import { childEnv } from '../server/agents/env.ts';
import { adapterFor } from '../server/agents/registry.ts';
import { fakeAgents, turn, type LaunchScript, type Step } from './support/fake-agent.ts';

const FIXTURES = new URL('./fixtures/codex-0.167.1/', import.meta.url);
const stdout = (name: string) => readFileSync(new URL(`${name}.raw.jsonl`, FIXTURES), 'utf8').split('\n').filter(Boolean)
  .map((l) => JSON.parse(l) as { dir: string; line: string }).filter((r) => r.dir === 'stdout').map((r) => JSON.parse(r.line) as Record<string, any>);

const spec = (over: Partial<SessionSpec> = {}): SessionSpec => ({
  cwd: '/work/mission', powers: { tools: ['Read', 'Write', 'Bash'], preapproved: [] }, access: 'write', autonomy: 'auto', systemPrompt: '지시문', ...over,
});

test('옵션: 첫 턴, 이어가기, 읽기 전용, 모델', () => {
  const cases: { name: string; spec: SessionSpec; thread?: string; want: string[] }[] = [
    {
      name: '첫 턴, 쓰기',
      spec: spec(),
      want: ['exec', '--json', '--ignore-user-config', '--skip-git-repo-check', '-C', '/work/mission', '-s', 'workspace-write', '-'],
    },
    {
      name: '첫 턴, 읽기 전용',
      spec: spec({ access: 'read' }),
      want: ['exec', '--json', '--ignore-user-config', '--skip-git-repo-check', '-C', '/work/mission', '-s', 'read-only', '-'],
    },
    {
      name: '첫 턴, 모델',
      spec: spec({ model: 'gpt-6-luna' }),
      want: ['exec', '--json', '--ignore-user-config', '--skip-git-repo-check', '-C', '/work/mission', '-s', 'workspace-write', '-m', 'gpt-6-luna', '-'],
    },
    {
      name: '이어가기는 -s와 -C가 없어서 샌드박스를 -c로 다시 준다',
      spec: spec(),
      thread: 'th-1',
      want: ['exec', 'resume', 'th-1', '--json', '--ignore-user-config', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"', '-'],
    },
    {
      name: '이어가기, 읽기 전용과 모델',
      spec: spec({ access: 'read', model: 'm' }),
      thread: 'th-2',
      want: ['exec', 'resume', 'th-2', '--json', '--ignore-user-config', '--skip-git-repo-check', '-c', 'sandbox_mode="read-only"', '-m', 'm', '-'],
    },
    {
      name: 'autonomy가 ask여도 danger-full-access는 없다',
      spec: spec({ autonomy: 'ask' }),
      want: ['exec', '--json', '--ignore-user-config', '--skip-git-repo-check', '-C', '/work/mission', '-s', 'workspace-write', '-'],
    },
  ];
  for (const c of cases) {
    const got = codexArgv(c.spec, c.thread);
    assert.deepEqual(got, c.want, c.name);
    assert.ok(!got.includes('--last'), '--last는 쓰지 않는다');
  }
});

test('프롬프트: 시스템 프롬프트는 새 스레드의 첫 말 앞에만 붙는다', () => {
  assert.equal(codexPrompt(spec(), '일해'), '지시문\n\n---\n\n일해');
  assert.equal(codexPrompt(spec(), '일해', 'th-1'), '일해');
  assert.equal(codexPrompt(spec({ systemPrompt: '' }), '일해'), '일해');
});

test('환경: codex의 API 키는 기본으로 빠지고 켜면 남는다', () => {
  const base = { PATH: '/bin', OPENAI_API_KEY: 'o', CODEX_API_KEY: 'c', ANTHROPIC_API_KEY: 'a' };
  assert.deepEqual(childEnv('codex', base, false), { PATH: '/bin', ANTHROPIC_API_KEY: 'a', BUREAU_DES_AGENTS: '1' });
  assert.deepEqual(childEnv('codex', base, true), { ...base, BUREAU_DES_AGENTS: '1' });
});

test('registry: codex는 열리고 gemini는 지원하지 않는다', async () => {
  assert.equal(adapterFor('codex'), codexAdapter);
  const gemini = await adapterFor('gemini').probe();
  assert.equal(gemini.found, false);
  assert.match(gemini.note ?? '', /지원하지 않아요/);
});

test('명령: 셸 껍데기를 벗긴다', () => {
  assert.equal(bareCommand(`/bin/zsh -lc "printf 'hello from codex.' > hello.txt"`), `printf 'hello from codex.' > hello.txt`);
  assert.equal(bareCommand(`/bin/zsh -lc 'cat hello.txt'`), 'cat hello.txt');
  assert.equal(bareCommand(`/bin/bash -lc "echo \\"a\\""`), 'echo "a"');
  assert.equal(bareCommand('ls -la'), 'ls -la');
});

// ── 줄 → 신호(녹화한 진짜 스트림) ──

function mapAll(name: string, cwd = '/work/mission') {
  const mapper = codexMapper(cwd);
  return stdout(name).flatMap((m) => mapper.feed(m));
}

test('매퍼: 첫 턴 녹화', () => {
  const signals = mapAll('first-turn', '<TMP>/codex-first-turn');
  const act = signals[2] as Extract<WorkerSignal, { k: 'act' }>;
  assert.match(act.label, /실행 중$/);
  assert.deepEqual(signals, [
    { k: 'session', ref: { id: '01a1cdde-aeac-75b0-a1e1-aeff8600e988', cwd: '<TMP>/codex-first-turn' } },
    { k: 'think' },
    { k: 'act', id: 'item_0', tool: 'Bash', kind: 'bash', label: act.label, detail: `printf 'hello from codex.' > hello.txt` },
    { k: 'act_done', id: 'item_0', ok: true },
    { k: 'say', text: 'done' },
    { k: 'usage', tokens: 34521 + 47, tools: 1 },
    { k: 'turn_end', text: 'done', ok: true, interrupted: false },
  ]);
});

test('매퍼: 이어가기 녹화는 같은 스레드와 새 턴이다', () => {
  const first = mapAll('first-turn');
  const resume = mapAll('resume');
  assert.deepEqual(resume[0], first[0]);
  assert.deepEqual(resume.map((s) => s.k), ['session', 'think', 'say', 'usage', 'turn_end']);
  assert.deepEqual(resume.at(-1), { k: 'turn_end', text: 'I can’t append to `hello.txt` because the current filesystem is read-only.', ok: true, interrupted: false });
});

test('매퍼: 샌드박스를 다시 준 이어가기는 명령 둘을 짝지어 낸다', () => {
  const signals = mapAll('resume-sandbox-override');
  const acts = signals.filter((s) => s.k === 'act');
  assert.deepEqual(acts.map((s) => s.k === 'act' && s.id), ['item_1', 'item_2']);
  assert.deepEqual(signals.filter((s) => s.k === 'act_done'), [{ k: 'act_done', id: 'item_1', ok: true }, { k: 'act_done', id: 'item_2', ok: true }]);
  assert.deepEqual(signals.filter((s) => s.k === 'say').map((s) => s.k === 'say' && s.text), ['기존 내용을 확인한 뒤 두 번째 줄을 덧붙이고, 파일 전체 내용을 확인하겠습니다.', 'hello from codex.\nsecond']);
  assert.deepEqual(signals.at(-1), { k: 'turn_end', text: 'hello from codex.\nsecond', ok: true, interrupted: false });
});

test('매퍼: SIGTERM 녹화는 턴을 끝내는 줄이 없어서 껍데기가 abort로 닫아야 한다', () => {
  const mapper = codexMapper('/w');
  const signals = stdout('sigterm').flatMap((m) => mapper.feed(m));
  assert.equal(signals.some((s) => s.k === 'turn_end'), false);
  assert.equal(signals.at(-1)?.k, 'act');
  assert.deepEqual(mapper.abort(true), { k: 'turn_end', text: '', ok: false, interrupted: true });
  // 닫은 뒤에는 다음 턴이 깨끗하게 시작한다
  assert.deepEqual(mapper.abort(false), { k: 'turn_end', text: '', ok: false, interrupted: false, error: 'exited' });
});

test('매퍼: turn.failed와 error', () => {
  const mapper = codexMapper('/w');
  assert.deepEqual(mapper.feed({ type: 'error', message: 'Reconnecting... 1/5' }), [], 'error만으로는 턴이 끝나지 않는다');
  assert.deepEqual(mapper.feed({ type: 'turn.failed', error: { message: 'boom' } }), [{ k: 'turn_end', text: '', ok: false, interrupted: false, error: 'boom' }]);
  assert.deepEqual(mapper.feed({ type: 'error', message: '연결 끊김' }), []);
  assert.deepEqual(mapper.abort(false), { k: 'turn_end', text: '', ok: false, interrupted: false, error: '연결 끊김' }, '죽을 때는 마지막 error가 이유다');
  assert.deepEqual(mapper.feed({ type: 'turn.failed' }), [{ k: 'turn_end', text: '', ok: false, interrupted: false, error: 'turn.failed' }]);
});

test('매퍼: 녹화에 없는 항목(파일 변경, 계획, 웹 검색, 실패한 명령)과 모르는 줄', () => {
  const mapper = codexMapper('/w');
  assert.deepEqual(mapper.feed({ type: 'whatever' }), []);
  assert.deepEqual(mapper.feed({ type: 'item.completed', item: { id: 'x', type: 'something_new' } }), []);
  const change = mapper.feed({ type: 'item.completed', item: { id: 'f1', type: 'file_change', status: 'completed', changes: [{ path: '/w/a.txt', kind: 'add' }] } });
  assert.deepEqual(change.map((s) => s.k), ['act', 'act_done'], '시작 없이 끝난 항목은 둘을 함께 낸다');
  assert.deepEqual(change[0], { k: 'act', id: 'f1', tool: 'Write', kind: 'write', label: 'a.txt 작성 중', detail: '/w/a.txt' });
  assert.deepEqual(mapper.feed({ type: 'item.completed', item: { id: 'p', type: 'todo_list', items: [{ text: 'a', completed: true }, { text: 'b', completed: false }, { text: 'c', completed: false }] } }),
    [{ k: 'plan', items: [{ text: 'a', status: 'completed' }, { text: 'b', status: 'in_progress' }, { text: 'c', status: 'pending' }] }]);
  assert.equal(mapper.feed({ type: 'item.started', item: { id: 'w', type: 'web_search', query: '날씨' } })[0].k, 'act');
  mapper.feed({ type: 'item.started', item: { id: 'c', type: 'command_execution', command: 'false', status: 'in_progress', exit_code: null } });
  assert.deepEqual(mapper.feed({ type: 'item.completed', item: { id: 'c', type: 'command_execution', command: 'false', status: 'completed', exit_code: 1 } }), [{ k: 'act_done', id: 'c', ok: false }]);
  assert.deepEqual(mapper.feed({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: '  ' } }), []);
});

// ── 프로세스 껍데기(가짜 에이전트의 codex 모드) ──

const tmp = () => realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bureau-codex-')));
const kinds = (s: WorkerSignal[]) => s.map((x) => x.k);

function open(launches: (Step[] | LaunchScript)[], over: Partial<SessionSpec> = {}) {
  const fake = fakeAgents({ codex: { launches } });
  const signals: WorkerSignal[] = [];
  const waiting: { pred: (s: WorkerSignal[]) => boolean; resolve: () => void }[] = [];
  const cwd = tmp();
  const session = codexAdapter.open(spec({ cwd, ...over }), { text: '첫 말' }, (s) => {
    signals.push(s);
    for (const w of waiting.filter((x) => x.pred(signals))) { waiting.splice(waiting.indexOf(w), 1); w.resolve(); }
  });
  const until = (pred: (s: WorkerSignal[]) => boolean) => new Promise<void>((resolve) => {
    if (pred(signals)) resolve(); else waiting.push({ pred, resolve });
  });
  const has = (k: WorkerSignal['k'], n = 1) => until((s) => s.filter((x) => x.k === k).length >= n);
  return { fake, session, signals, has, until, cwd };
}

const running = (id = 'item_0') => ({ emit: { type: 'item.started', item: { id, type: 'command_execution', command: 'sleep 60', aggregated_output: '', exit_code: null, status: 'in_progress' } } }) as Step;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const settle = async (pid: number) => { for (let i = 0; i < 150 && alive(pid); i++) await new Promise((r) => setTimeout(r, 20)); };

test('껍데기: 첫 턴은 exec 옵션과 시스템 프롬프트가 붙은 stdin으로 돌고 turn_end 하나로 끝난다', async () => {
  const o = open([turn({ command: { run: '/bin/zsh -lc "ls"' } }, { say: { text: '끝', usage: { input_tokens: 10, output_tokens: 5 } } })]);
  await o.has('turn_end');
  assert.deepEqual(kinds(o.signals), ['session', 'think', 'act', 'act_done', 'say', 'usage', 'turn_end']);
  const [launch] = o.fake.launches('codex');
  assert.deepEqual(launch.argv, codexArgv(spec({ cwd: o.cwd })));
  assert.equal(launch.cwd, o.cwd);
  assert.equal(launch.stdin[0], '지시문\n\n---\n\n첫 말');
  assert.equal(o.session.alive, true, '턴이 끝나도 세션은 산다');
  await o.session.park();
  assert.equal(o.session.alive, true);
  o.fake.assertClean();
});

test('껍데기: 이어가기는 같은 스레드와 같은 폴더를 쓰고, 샌드박스를 다시 주고, 시스템 프롬프트를 다시 붙이지 않는다', async () => {
  const o = open([
    { thread: 'th-fixed', steps: turn({ say: { text: '하나' } }) },
    turn({ say: { text: '둘' } }),
  ]);
  await o.has('turn_end');
  o.session.send({ text: '두 번째 말' }, 'turn');
  await o.has('turn_end', 2);
  const [a, b] = o.fake.launches('codex');
  assert.deepEqual(b.argv, codexArgv(spec({ cwd: o.cwd }), 'th-fixed'));
  assert.ok(b.argv.includes('sandbox_mode="workspace-write"'));
  assert.equal(b.cwd, a.cwd);
  assert.equal(b.cwd, o.cwd);
  assert.equal(b.stdin[0], '두 번째 말');
  const ends = o.signals.filter((s) => s.k === 'turn_end');
  assert.deepEqual(ends.map((s) => s.k === 'turn_end' && s.text), ['하나', '둘']);
  const sessions = o.signals.filter((s) => s.k === 'session');
  assert.deepEqual(sessions[0], sessions[1]);
  assert.equal(sessions[1].k === 'session' && sessions[1].ref.id, 'th-fixed');
  o.fake.assertClean();
});

test('껍데기: 세션을 다시 열면(spec.resume) 처음부터 resume이고 시스템 프롬프트가 없다', async () => {
  const o = open([turn({ say: { text: '이어서' } })], { resume: { id: 'old-thread', cwd: '/x' }, access: 'read' });
  await o.has('turn_end');
  const [l] = o.fake.launches('codex');
  assert.deepEqual(l.argv.slice(0, 3), ['exec', 'resume', 'old-thread']);
  assert.ok(l.argv.includes('sandbox_mode="read-only"'));
  assert.equal(l.stdin[0], '첫 말');
});

test('껍데기: 앞의 턴이 도는 중의 send와 steer는 던진다', async () => {
  const o = open([turn(running(), { hang: true })]);
  await o.has('act');
  assert.throws(() => o.session.send({ text: 'x' }, 'turn'), /끝나지 않았어요/);
  assert.throws(() => o.session.send({ text: 'x' }, 'steer'), /끼어들 수 없어요/);
  o.session.kill();
  await o.has('exit');
});

test('껍데기: turn.failed는 실패한 turn_end 하나이고 세션은 산다', async () => {
  const o = open([turn({ emit: { type: 'turn.failed', error: { message: '한도 초과' } } }, { exit: 1 })]);
  await o.has('turn_end');
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(kinds(o.signals), ['session', 'think', 'turn_end']);
  const end = o.signals.at(-1);
  assert.deepEqual(end, { k: 'turn_end', text: '', ok: false, interrupted: false, error: '한도 초과' });
  assert.equal(o.session.alive, true);
});

test('껍데기: 턴 도중에 프로세스가 끝나면 turn_end(실패) 하나 뒤에 exit가 오고 send는 던진다', async () => {
  const o = open([turn({ exit: 3 })]);
  await o.has('exit');
  assert.deepEqual(kinds(o.signals).slice(-2), ['turn_end', 'exit']);
  assert.equal(kinds(o.signals).filter((k) => k === 'turn_end').length, 1);
  const end = o.signals.find((s) => s.k === 'turn_end');
  assert.deepEqual(end && end.k === 'turn_end' && [end.ok, end.interrupted, end.error], [false, false, 'exited']);
  const exit = o.signals.at(-1);
  assert.deepEqual(exit?.k === 'exit' && [exit.code, exit.expected], [3, false]);
  assert.equal(o.session.alive, false);
  assert.throws(() => o.session.send({ text: 'x' }, 'turn'), /이미 끝났어요/);
});

test('껍데기: 턴 도중에 SIGKILL로 죽어도 turn_end(실패) 하나 뒤에 exit 하나다', async () => {
  const o = open([turn({ crash: true })]);
  await o.has('exit');
  assert.deepEqual(kinds(o.signals).slice(-2), ['turn_end', 'exit']);
  assert.equal(kinds(o.signals).filter((k) => k === 'turn_end' || k === 'exit').length, 2);
  const exit = o.signals.at(-1);
  assert.deepEqual(exit?.k === 'exit' && [exit.code, exit.signal, exit.expected], [null, 'SIGKILL', false]);
});

test('껍데기: 읽을 수 없는 줄은 diag, 빈 줄은 건너뛴다', async () => {
  const o = open([turn({ emit: ['배너: 안녕', ''] }, { say: { text: 'ok' } })]);
  await o.has('turn_end');
  assert.deepEqual(o.signals.filter((s) => s.k === 'diag'), [{ k: 'diag', line: '배너: 안녕' }]);
});

test('껍데기: interrupt는 프로세스 그룹을 멈추고 turn_end(interrupted) 하나를 내며 세션은 산다', async () => {
  const pidFile = path.join(tmp(), 'child.pid');
  const o = open([
    [{ expectInput: {} }, { child: { pidFile } }, { begin: true }, running(), { hang: true }],
    turn({ say: { text: '다시 살아남' } }),
  ]);
  await o.has('act');
  const child = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(alive(child));
  o.session.interrupt();
  o.session.interrupt();
  await o.has('turn_end');
  await new Promise((r) => setTimeout(r, 200));
  const ends = o.signals.filter((s) => s.k === 'turn_end');
  assert.deepEqual(ends, [{ k: 'turn_end', text: '', ok: false, interrupted: true }]);
  assert.equal(o.signals.some((s) => s.k === 'exit'), false);
  await settle(child);
  assert.equal(alive(child), false, '하위 프로세스도 멈춰야 해요');
  assert.equal(o.session.alive, true);
  o.session.send({ text: '다시' }, 'turn');
  await o.has('turn_end', 2);
  assert.deepEqual(o.signals.filter((s) => s.k === 'turn_end').map((s) => s.k === 'turn_end' && [s.ok, s.interrupted]), [[false, true], [true, false]]);
  const [, second] = o.fake.launches('codex');
  assert.equal(second.argv[1], 'resume');
  o.fake.assertClean();
});

test('껍데기: 턴이 끝난 뒤의 interrupt는 아무것도 하지 않는다', async () => {
  const o = open([turn({ say: { text: '끝' } })]);
  await o.has('turn_end');
  o.session.interrupt();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(kinds(o.signals).filter((k) => k === 'turn_end').length, 1);
});

test('껍데기: kill 뒤에는 exit 하나 말고 아무 신호도 없고, 프로세스 그룹이 사라진다', async () => {
  const pidFile = path.join(tmp(), 'child.pid');
  const o = open([[{ expectInput: {} }, { child: { pidFile } }, { begin: true }, running(), { hang: true }]]);
  await o.has('act');
  const child = Number(readFileSync(pidFile, 'utf8'));
  assert.doesNotThrow(() => process.kill(child, 0));
  const before = o.signals.length;
  o.session.kill();
  o.session.kill();
  await o.has('exit');
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(o.signals.slice(before).map((s) => s.k), ['exit']);
  const exit = o.signals.at(-1);
  assert.deepEqual(exit?.k === 'exit' && [exit.signal, exit.expected], ['SIGTERM', true]);
  await settle(child);
  assert.equal(alive(child), false, '하위 프로세스도 멈춰야 해요');
  assert.equal(o.session.alive, false);
  assert.throws(() => o.session.send({ text: 'x' }, 'turn'), /이미 끝났어요/);
});

test('껍데기: 턴 사이에 kill해도 exit는 하나다', async () => {
  const o = open([turn({ say: { text: '끝' } })]);
  await o.has('turn_end');
  await new Promise((r) => setTimeout(r, 100));
  o.session.kill();
  o.session.kill();
  await o.has('exit');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(kinds(o.signals).filter((k) => k === 'exit').length, 1);
  assert.equal(kinds(o.signals).at(-1), 'exit');
});

test('probe: CODEX_BIN이 가리키는 실행 파일의 버전, 능력, 안내', async () => {
  fakeAgents({ codex: [] });
  const probe = await codexAdapter.probe();
  assert.equal(probe.found, true);
  assert.equal(probe.version, '9.9.9');
  assert.equal(probe.vendor, 'OpenAI');
  assert.deepEqual(probe.caps, { approvals: false, steer: false, liveSession: false, web: false, hostTools: false });
  assert.match(probe.note ?? '', /허락을 물을 수 없어요.*샌드박스/);
});
