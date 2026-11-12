// 진짜 서버 프로세스(server/index.ts) 전체: WebSocket으로 미션을 시작하고, 가짜 맥스가 서버에 달린 MCP 끝점으로 계획하고,
// 가짜 일꾼 둘(claude, codex)이 의존 순서대로 일하고, settle이 소켓으로 온다. 구독을 쓰지 않는다.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { OfficeEvent, ServerMsg } from '../shared/protocol.ts';
import { fakeAgents, turn, type LaunchScript } from './support/fake-agent.ts';
import { spawnOffice } from './support/office-process.ts';

const LEAD = '^(?![\\s\\S]*--resume)(?=[\\s\\S]*--mcp-config )';
const PLAN = {
  tasks: [
    { key: 'note', title: '메모 쓰기', brief: 'BRIEF-NOTE a.txt에 한 줄을 써 주세요.', role: 'redaction', agent: 'claude' },
    { key: 'copy', title: '메모 옮기기', brief: 'BRIEF-COPY b.txt를 만들어 주세요.', role: 'code', agent: 'codex', after: ['note'] },
  ],
};

function post(base: string, urlPath: string, headers: Record<string, string>): Promise<number> {
  const u = new URL(base);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: urlPath, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers } }, (res) => {
      res.resume().on('end', () => resolve(res.statusCode!));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const kinds = (es: OfficeEvent[]) => es.map((e) => e.k);
const ofKind = <K extends OfficeEvent['k']>(es: OfficeEvent[], k: K) => es.filter((e): e is Extract<OfficeEvent, { k: K }> => e.k === k);

test('진짜 서버: 소켓으로 시작, MCP로 계획, claude 다음 codex, settle, 새 미션 때 end', async () => {
  const launches = {
    claude: {
      launches: [
        {
          match: LEAD, steps: [
            ...turn({ mcp: { tool: 'office_plan', args: PLAN, expectResult: '2개를 받았어요' } }, { say: { text: '둘에게 나눠 맡겼어요.' } }),
            { expectInput: '\\[사무실 소식\\][\\s\\S]*note' }, { begin: true }, { say: { text: '메모가 나왔어요.' } },
            { expectInput: '모든 할 일이 끝났어요' }, { begin: true }, { say: { text: 'a.txt와 b.txt를 만들었어요!' } },
          ],
        },
        {
          match: 'BRIEF-NOTE',
          steps: turn({ writeFile: { path: 'a.txt', content: '안녕\n' } }, { tool: { name: 'Write', input: { file_path: '{{cwd}}/a.txt' } } },
            { handback: { block: { status: 'done', summary: 'SUMMARY-NOTE a.txt에 안녕', files: ['a.txt'] } } }),
        },
      ] satisfies LaunchScript[],
    },
    codex: {
      launches: [{
        match: 'BRIEF-COPY',
        // 맥스가 note 소식으로 한 턴을 다 마친 뒤에 끝나야, 마지막 소식이 따로 온다(소식은 1.5초씩 모은다)
        steps: turn({ wait: 2500 }, { writeFile: { path: 'b.txt', content: '안녕\n' } }, { command: { run: "/bin/zsh -lc 'cp a.txt b.txt'" } },
          { handback: { block: { status: 'done', summary: 'SUMMARY-COPY b.txt' } } }),
      }] satisfies LaunchScript[],
    },
  };
  const fakes = fakeAgents(launches);
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'office-server-')));
  const env: NodeJS.ProcessEnv = { ...process.env, BUREAU_DIR: path.join(tmp, 'office'), CLAUDE_BIN: fakes.bin.claude, CODEX_BIN: fakes.bin.codex };
  delete env.BUREAU_RECORD;
  const office = await spawnOffice({ env });
  try {
    await office.until((m) => m.some((x) => x.t === 'hello'), 5000);
    const hello = office.msgs.find((x): x is Extract<ServerMsg, { t: 'hello' }> => x.t === 'hello')!;
    assert.deepEqual(hello.agents?.map((a) => [a.kind, a.found]), [['claude', true], ['codex', true], ['gemini', false]]);

    office.send({ t: 'settings', settings: { chefModel: 'haiku', teamModel: 'haiku', codexModel: 'fake-mini' } });
    await office.until((m) => m.some((x) => x.t === 'settings' && x.settings.codexModel === 'fake-mini'), 5000);
    office.send({ t: 'start', prompt: '메모를 쓰고 옮겨 주세요.' });
    await office.until(() => office.events().some((e) => e.k === 'settle'), 20_000);
    fakes.assertClean();

    const es = office.events();
    assert.deepEqual(ofKind(es, 'settle'), [{ k: 'settle', text: 'a.txt와 b.txt를 만들었어요!' }]);
    assert.equal(ofKind(es, 'init')[0]?.model, 'haiku', '미션의 모델은 맥스의 init에서 온다');
    const hires = ofKind(es, 'hire');
    assert.deepEqual(hires.map((h) => [h.task, h.agent]), [['메모 쓰기', 'claude'], ['메모 옮기기', 'codex']]);
    const [note, copy] = hires.map((h) => h.id);
    const working = (id: string) => es.findIndex((e) => e.k === 'worker' && e.id === id && e.phase === 'working');
    const reported = (id: string) => es.findIndex((e) => e.k === 'report' && e.who === id);
    assert.ok(reported(note) >= 0 && reported(note) < working(copy), 'codex 일꾼은 claude 일꾼이 끝난 뒤에 일한다');

    const files = Object.fromEntries(ofKind(es, 'file').map((f) => [f.file.path, f.file.by]));
    assert.deepEqual(files, { 'a.txt': note, 'b.txt': copy }, 'Write로 쓴 파일과 명령으로 쓴 파일 모두 쓴 일꾼에게 간다');
    const done = office.msgs.filter((x): x is Extract<ServerMsg, { t: 'mission' }> => x.t === 'mission').at(-1)!.mission;
    assert.equal(done.status, 'done');
    assert.equal(done.final, 'a.txt와 b.txt를 만들었어요!');
    assert.equal(done.model, 'haiku');

    const lead = fakes.launches('claude').find((l) => l.argv.includes('--mcp-config'))!;
    const arg = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1];
    assert.ok(!arg(lead.argv, '--tools').split(',').some((t) => t === 'Agent' || t === 'TodoWrite'), '맥스에게 Agent와 TodoWrite가 없다');
    assert.ok(!lead.argv.includes('--agents'));
    assert.match(arg(lead.argv, '--append-system-prompt'), /office_plan/);
    assert.match(arg(lead.argv, '--append-system-prompt'), /고를 수 있는 agent: claude, codex/);
    const [codex] = fakes.launches('codex');
    assert.equal(arg(codex.argv, '-m'), 'fake-mini', 'codex 일꾼은 codex의 모델을 쓴다');
    assert.match(codex.stdin[0], /```data\nSUMMARY-NOTE a\.txt에 안녕\n```/, '뒤의 일은 앞의 결과를 자료로 받는다');
    const worker = fakes.launches('claude').find((l) => l.stdin.some((s) => s.includes('BRIEF-NOTE')))!;
    assert.equal(arg(worker.argv, '--model'), 'haiku');

    const url = JSON.parse(arg(lead.argv, '--mcp-config')).mcpServers.office.url as string;
    const mcpPath = new URL(url).pathname;
    assert.equal(await post(office.base, mcpPath, { origin: 'https://evil.example' }), 403, '다른 사이트에서 온 요청은 거절한다');
    assert.equal(await post(office.base, mcpPath, { host: `evil.example:${office.port}` }), 403, '루프백이 아닌 Host는 거절한다');
    assert.equal(await post(office.base, '/lead/0123456789abcdef0123456789abcdef/mcp', {}), 404, '모르는 토큰');

    office.send({ t: 'new' });
    await office.until((m) => m.some((x) => x.t === 'closed'), 10_000);
    const ends = ofKind(office.events(), 'end');
    assert.equal(ends.length, 1);
    assert.ok(ends[0].ms > 0, `end.ms는 미션의 작업 시간이다: ${ends[0].ms}`);
    assert.equal(ofKind(office.events(), 'leave').length, 2);
    assert.equal(await post(office.base, mcpPath, {}), 404, '미션을 놓아주면 맥스의 토큰도 사라진다');

    assert.ok(!JSON.stringify(office.events()).includes(tmp), '이벤트에 전체 경로가 없다');
  } finally {
    await office.stop();
  }
  // 기록 파일은 비동기로 이어 쓴다: 서버가 끝난 뒤에 읽는다
  const missions = path.join(tmp, 'office', '.bureau', 'missions');
  const id = office.msgs.flatMap((m) => (m.t === 'mission' ? [m.mission.id] : []))[0];
  const saved = readFileSync(path.join(missions, `${id}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).ev as OfficeEvent);
  assert.deepEqual(kinds(saved), kinds(office.events().filter((e) => e.k !== 'typing')), '기록은 방송한 것과 같다');
  assert.ok(existsSync(path.join(missions, `${id}.state.json`)));
});
