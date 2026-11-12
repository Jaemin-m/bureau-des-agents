// 저장소 미션: 진짜 서버 프로세스, 진짜 git(임시 저장소), 가짜 에이전트. 쓰는 할 일마다 브랜치와 worktree, 읽는 할 일과 맥스는 렌즈,
// 사무실이 커밋하고, 사용자의 체크아웃은 사용자가 “합치기”를 누를 때까지 그대로다. 구독을 쓰지 않는다.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { OfficeEvent, ServerMsg, TaskNode } from '../shared/protocol.ts';
import { Conductor } from '../server/conductor/shell.ts';
import { branchName, provision } from '../server/workspaces.ts';
import { fakeAgents, turn, type LaunchScript, type Step } from './support/fake-agent.ts';
import { makeRepo, sh } from './support/git-fixture.ts';
import { spawnOffice } from './support/office-process.ts';
import { conductorRig } from './support/scenario.ts';

const HOST = fileURLToPath(new URL('./support/conductor-host.ts', import.meta.url));

const LEAD = '^(?![\\s\\S]*--resume)(?=[\\s\\S]*--mcp-config )';
const PLAN = {
  tasks: [
    { key: 'api', title: 'API 만들기', brief: 'BRIEF-API src/api.ts를 만들어 주세요.', role: 'code' },
    { key: 'ui', title: '화면 만들기', brief: 'BRIEF-UI src/ui.ts를 만들어 주세요.', role: 'code', after: ['api'] },
    { key: 'look', title: '저장소 둘러보기', brief: 'BRIEF-LOOK README를 읽어 주세요.', role: 'recherche', access: 'read' },
  ],
};
/** 맥스는 소식이 올 때마다 깬다(몇 번 깨는지는 소식을 모으는 시간에 달렸다) */
const anyTurn = (n: number): Step[] => Array.from({ length: n }, (_, i) => [{ expectInput: '.' }, { begin: true }, { say: { text: `맥스의 말 ${i + 1}` } }] as Step[]).flat();
const done = (summary: string): Step => ({ handback: { block: { status: 'done', summary } } });

const ofKind = <K extends OfficeEvent['k']>(es: OfficeEvent[], k: K) => es.filter((e): e is Extract<OfficeEvent, { k: K }> => e.k === k);
const lastTask = (es: OfficeEvent[], key: string) => ofKind(es, 'task').filter((t) => t.key === key).at(-1) as TaskNode | undefined;
const toast = (m: ServerMsg[], kind: 'info' | 'error', re: RegExp) => m.some((x) => x.t === 'toast' && x.kind === kind && re.test(x.text));
const hasRef = (dir: string, ref: string) => spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: dir }).status === 0;

async function get(base: string, urlPath: string): Promise<number> {
  const r = await fetch(base + urlPath);
  await r.arrayBuffer();
  return r.status;
}

test('저장소 미션: 브랜치마다 worktree, 렌즈, 사무실 커밋, 비밀 파일 보류, 막힌 합치기와 합치기, 버리기와 되살리기, 경로 탈출 거부', { timeout: 60_000 }, async () => {
  const launches: LaunchScript[] = [
    { match: LEAD, session: 'sess-lead', steps: [...turn({ mcp: { tool: 'office_plan', args: PLAN, expectResult: '3개를 받았어요' } }, { say: { text: '셋에게 맡겼어요.' } }), ...anyTurn(6)] },
    {
      match: 'BRIEF-API',
      steps: turn({ writeFile: { path: 'src/api.ts', content: 'export const api = 1;\n' } }, { writeFile: { path: '.env', content: 'TOKEN=secret\n' } },
        { tool: { name: 'Write', input: { file_path: '{{cwd}}/src/api.ts' } } }, done('SUMMARY-API src/api.ts')),
    },
    { match: 'BRIEF-UI', steps: turn({ writeFile: { path: 'src/ui.ts', content: 'import { api } from "./api";\n' } }, done('SUMMARY-UI src/ui.ts')) },
    { match: 'BRIEF-LOOK', steps: turn({ tool: { name: 'Read', input: { file_path: '{{cwd}}/README.md' } } }, done('SUMMARY-LOOK README는 한 줄이에요')) },
  ];
  const fakes = fakeAgents({ claude: { launches } });
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'repo-mission-')));
  const repo = makeRepo(path.join(tmp, 'user-repo'));
  const snap = () => ({ head: sh(repo.root, 'rev-parse', 'HEAD'), status: sh(repo.root, 'status', '--porcelain') });
  const before = snap();
  const worktrees = path.join(tmp, 'worktrees');
  const env: NodeJS.ProcessEnv = { ...process.env, BUREAU_DIR: path.join(tmp, 'office'), BUREAU_WORKTREES: worktrees, CLAUDE_BIN: fakes.bin.claude };
  delete env.BUREAU_RECORD;
  delete env.CODEX_BIN;
  const office = await spawnOffice({ env });
  try {
    await office.until((m) => m.some((x) => x.t === 'hello'), 5000);

    const plain = path.join(tmp, 'plain');
    mkdirSync(plain);
    office.send({ t: 'repo_check', path: plain });
    await office.until((m) => m.some((x) => x.t === 'repo_info' && x.path === plain), 5000);
    const refused = office.msgs.find((x): x is Extract<ServerMsg, { t: 'repo_info' }> => x.t === 'repo_info' && x.path === plain)!;
    assert.equal(refused.ok, false);
    assert.match(refused.why!, /git 저장소가 아니에요/, '저장소가 아닌 폴더는 한국어 이유와 함께 거절한다');
    office.send({ t: 'repo_check', path: repo.root });
    await office.until((m) => m.some((x) => x.t === 'repo_info' && x.path === repo.root), 5000);
    const info = office.msgs.find((x): x is Extract<ServerMsg, { t: 'repo_info' }> => x.t === 'repo_info' && x.path === repo.root)!;
    assert.deepEqual(info, { t: 'repo_info', path: repo.root, ok: true, label: 'user-repo', branch: 'main', dirty: false });

    office.send({ t: 'start', prompt: '저장소에 API와 화면을 만들어 주세요.', target: { repo: repo.root } });
    await office.until(() => office.events().some((e) => e.k === 'settle'), 30_000);
    fakes.assertClean();
    assert.deepEqual(snap(), before, '미션 내내 사용자의 체크아웃(HEAD, status)은 그대로다');

    const mission = office.msgs.filter((x): x is Extract<ServerMsg, { t: 'mission' }> => x.t === 'mission').at(-1)!.mission;
    assert.deepEqual(mission.target, { kind: 'repo', label: 'user-repo', baseBranch: 'main' });
    const id = mission.id;
    const es = office.events();
    const by = (title: string) => ofKind(es, 'hire').find((h) => h.task === title)!.id;
    const [apiW, uiW] = [by('API 만들기'), by('화면 만들기')];

    const cwd = (re: RegExp) => fakes.launches('claude').find((l) => l.stdin.some((s) => re.test(s)))!.cwd;
    const lens = (key: string) => path.join(worktrees, id, key);
    assert.equal(fakes.launches('claude').find((l) => l.argv.includes('--mcp-config'))!.cwd, lens('lead'), '맥스는 기준 커밋의 읽기 렌즈에서 일한다');
    assert.equal(cwd(/BRIEF-LOOK/), lens('look'), '읽는 할 일은 자기 렌즈에서 일한다');
    assert.equal(cwd(/BRIEF-API/), lens('api'));
    assert.equal(cwd(/BRIEF-UI/), lens('ui'));
    for (const re of [/BRIEF-LOOK/, /BRIEF-API/, /BRIEF-UI/]) assert.notEqual(cwd(re), repo.root, '아무도 사용자의 체크아웃에서 일하지 않는다');
    assert.equal(sh(lens('look'), 'rev-parse', 'HEAD'), repo.baseSha);
    assert.throws(() => sh(lens('look'), 'symbolic-ref', '-q', 'HEAD'), '렌즈는 브랜치가 아니다(분리된 HEAD)');

    const api = branchName(id, 'api');
    const ui = branchName(id, 'ui');
    assert.equal(sh(repo.root, 'log', '-1', '--format=%s', api), 'api: API 만들기', '사무실이 할 일 이름으로 커밋했다');
    assert.equal(sh(repo.root, 'log', '-1', '--format=%an', api), '에이전트 사무실');
    assert.equal(sh(repo.root, 'show', `${api}:src/api.ts`), 'export const api = 1;');
    assert.ok(!sh(repo.root, 'ls-tree', '-r', '--name-only', api).split('\n').includes('.env'), '.env는 커밋하지 않는다');
    assert.ok(existsSync(path.join(lens('api'), '.env')), '.env는 작업 폴더에 그대로 있다');
    assert.ok(ofKind(es, 'worker').some((w) => w.id === apiW && /\.env\(비밀일 수 있어요\)/.test(w.note ?? '')), '일꾼 카드에 보관하지 않은 비밀 파일을 알린다');
    assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', api, ui], { cwd: repo.root }).status, 0, '뒤 할 일은 앞 할 일의 브랜치에서 시작했다');
    assert.equal(sh(repo.root, 'show', `${ui}:src/ui.ts`), 'import { api } from "./api";');

    const apiTask = lastTask(es, 'api')!;
    assert.equal(apiTask.run.k, 'done');
    if (apiTask.run.k === 'done') {
      const { summary, head, ...rest } = apiTask.run.result;
      assert.equal(summary, 'SUMMARY-API src/api.ts');
      assert.equal(head, sh(repo.root, 'rev-parse', api));
      assert.deepEqual(rest, { branch: api, base: 'main', files: 1, ins: 1, del: 0, mergeable: 'clean', by: apiW }, '끝난 할 일에 브랜치, 차이, 합칠 수 있는지가 실린다');
    }
    const lookTask = lastTask(es, 'look')!;
    assert.ok(lookTask.run.k === 'done' && lookTask.run.result.branch === undefined, '읽는 할 일에는 브랜치가 없다');

    const files = Object.fromEntries(ofKind(es, 'file').map((f) => [f.file.path, f.file.by]));
    assert.equal(files['api/src/api.ts'], apiW, '파일은 할 일 키 아래에, 쓴 일꾼은 정확하게');
    assert.equal(files['ui/src/ui.ts'], uiW);
    assert.equal(files['ui/src/api.ts'], undefined, '앞 할 일에서 온 파일은 뒤 일꾼의 것이 아니다');
    assert.ok(!JSON.stringify(office.events()).includes(tmp), '이벤트에 전체 경로가 없다');

    assert.equal(await get(office.base, `/apercu/${id}/api/src/api.ts`), 200, '작업 폴더의 파일은 미리 볼 수 있다');
    symlinkSync(path.join(repo.root, 'README.md'), path.join(lens('api'), 'leak.md'));
    for (const escape of [
      `/apercu/${id}/api/..%2F..%2F..%2Fuser-repo%2FREADME.md`, `/apercu/${id}/..%2F..%2F..%2F..%2Fetc%2Fpasswd`, `/apercu/${id}/api/leak.md`,
      `/apercu/${id}/lead/README.md`, `/apercu/${id}/%2Fetc%2Fpasswd`,
    ]) assert.equal(await get(office.base, escape), 404, `미리보기 탈출 거부: ${escape}`);
    const escapes = ['api/../../../user-repo/README.md', 'api/leak.md', '/etc/passwd', 'lead/README.md'];
    for (const [i, file] of escapes.entries()) {
      office.send({ t: 'read', missionId: id, file });
      await office.until((m) => m.filter((x) => x.t === 'toast' && /미션 폴더 안에 없어요/.test(x.text)).length > i, 5000);
    }
    assert.ok(!office.msgs.some((x) => x.t === 'file_text'), '읽기 탈출은 한 번도 글을 돌려주지 않는다');
    rmSync(path.join(lens('api'), 'leak.md'));

    office.send({ t: 'merge_check', taskKey: 'api' });
    await office.until((m) => m.some((x) => x.t === 'merge_info' && x.taskKey === 'api'), 5000);
    assert.ok(office.msgs.some((x) => x.t === 'merge_info' && x.taskKey === 'api' && x.ok), '깨끗한 체크아웃에는 합칠 수 있다');

    writeFileSync(path.join(repo.root, 'scratch.txt'), '사용자가 하던 일\n');
    const dirty = snap();
    office.send({ t: 'merge_check', taskKey: 'api' });
    await office.until((m) => m.some((x) => x.t === 'merge_info' && !x.ok && /저장하지 않은 변경/.test(x.why ?? '')), 5000);
    office.send({ t: 'merge', taskKey: 'api' });
    await office.until((m) => toast(m, 'error', /저장하지 않은 변경이 있어요/), 5000);
    assert.deepEqual(snap(), dirty, '더러운 체크아웃이면 합치지 않고 아무것도 바꾸지 않는다');
    rmSync(path.join(repo.root, 'scratch.txt'));

    office.send({ t: 'merge', taskKey: 'api' });
    await office.until((m) => toast(m, 'info', /합쳤어요/), 5000);
    assert.equal(sh(repo.root, 'rev-parse', 'HEAD^2'), sh(repo.root, 'rev-parse', api), '합치기는 --no-ff 병합 커밋이다');
    assert.equal(sh(repo.root, 'show', 'HEAD:src/api.ts'), 'export const api = 1;');
    assert.equal(sh(repo.root, 'status', '--porcelain'), '');
    await office.until(() => { const t = lastTask(office.events(), 'api'); return t?.run.k === 'done' && t.run.result.merged === true; }, 5000);

    const uiTip = sh(repo.root, 'rev-parse', ui);
    office.send({ t: 'discard_branch', taskKey: 'ui' });
    await office.until((m) => toast(m, 'info', /보관함으로 옮겼어요/), 10_000);
    const archived = `refs/bureau/archive/${id}/ui`;
    assert.ok(!hasRef(repo.root, `refs/heads/${ui}`), '브랜치는 보관 ref로 옮겨졌다');
    assert.equal(sh(repo.root, 'rev-parse', archived), uiTip, '보관 ref가 같은 커밋을 가리킨다');
    assert.ok(!existsSync(lens('ui')), '버린 일꾼의 작업 폴더는 정리됐다');
    assert.ok(ofKind(office.events(), 'leave').some((l) => l.who === uiW), '버린 브랜치의 일꾼은 사무실을 떠난다');
    await office.until(() => { const t = lastTask(office.events(), 'ui'); return t?.run.k === 'done' && t.run.result.archived === true; }, 5000);
    sh(repo.root, 'branch', 'recovered', archived);
    assert.equal(sh(repo.root, 'show', 'recovered:src/ui.ts'), 'import { api } from "./api";', '보관한 브랜치는 되살릴 수 있다');

    office.send({ t: 'new' });
    await office.until((m) => m.some((x) => x.t === 'closed'), 10_000);
    for (let i = 0; i < 100 && existsSync(lens('lead')); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(!existsSync(lens('lead')), '미션을 놓아주면 맥스의 렌즈를 정리한다');
    assert.ok(hasRef(repo.root, `refs/heads/${api}`), '미션을 놓아줘도 브랜치는 남는다');
    assert.ok(existsSync(path.join(lens('api'), '.env')), '보관하지 않은 파일이 있는 작업 폴더는 지우지 않는다');
  } finally {
    await office.stop();
  }
});

test('저장소 미션이 죽었다 켜지기: 작업 폴더를 지우지 않고 받아들이고, 하던 작업을 보관하고, 같은 폴더에서 이어간다', { timeout: 60_000 }, async (t) => {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'repo-restart-')));
  const worktrees = path.join(tmp, 'worktrees');
  process.env.BUREAU_WORKTREES = worktrees;
  const repo = makeRepo(path.join(tmp, 'user-repo'));
  const snap = () => ({ head: sh(repo.root, 'rev-parse', 'HEAD'), status: sh(repo.root, 'status', '--porcelain') });
  const before = snap();
  const childPid = path.join(tmp, 'child.pid');
  const launches: LaunchScript[] = [
    { match: LEAD, session: 'sess-lead', steps: turn({ mcp: { tool: 'office_plan', args: { tasks: [{ key: 'draw', title: '로고', brief: 'BRIEF-DRAW 로고를 그려 주세요.', role: 'code' }] } } }, { say: { text: '맡겼어요.' } }) },
    {
      match: 'BRIEF-DRAW', session: 'sess-draw',
      steps: turn({ writeFile: { path: 'logo.svg', content: '<svg/>\n' } }, { child: { pidFile: childPid } }, { tool: { name: 'Write', input: { file_path: '{{cwd}}/logo.svg' } } }, { hang: true }),
    },
    { match: '--resume sess-draw', steps: [{ expectInput: '멈췄던 일을 이어서 해 주세요' }, { begin: true }, { writeFile: { path: 'logo.svg', content: '<svg>v2</svg>\n' } }, done('SUMMARY-DRAW logo.svg')] },
    { match: '--resume sess-lead', steps: [{ expectInput: 'SUMMARY-DRAW' }, { begin: true }, { say: { text: '로고를 다 그렸어요.' } }] },
  ];
  const rig = await conductorRig({ scripts: { claude: { launches } } });
  const m = rig.mission('repo-restart');
  const mission = { id: m.name, repo };
  const lens = await provision({ mission, task: 'lead', access: 'read', upstream: [] });
  assert.ok(lens.kind === 'ready' && lens.ref.kind === 'lens');
  const deps = { ...m.deps, repo: { mission, lead: lens.ref } };

  const host = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', HOST], {
    env: { ...process.env, CONDUCTOR_HOST: JSON.stringify({ missionId: m.name, folder: m.folder, stateFile: m.stateFile, opening: '로고를 만들어 주세요.', repo: deps.repo }) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const seen: OfficeEvent[] = [];
  readline.createInterface({ input: host.stdout }).on('line', (l) => seen.push(JSON.parse(l) as OfficeEvent));
  const exited = new Promise((r) => host.on('close', r));
  for (let i = 0; i < 400 && !(existsSync(childPid) && seen.some((e) => e.k === 'act' && e.tool === 'Write')); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(existsSync(childPid), '일꾼이 일하는 중이다');
  host.kill('SIGKILL');
  await exited;
  t.after(() => { try { process.kill(-Number(readFileSync(childPid, 'utf8')), 'SIGKILL'); } catch { /* 이미 끝났다 */ } });

  const wt = path.join(worktrees, m.name, 'draw');
  assert.ok(existsSync(path.join(wt, 'logo.svg')), '죽기 전에 쓴 파일이 작업 폴더에 있다');
  assert.ok(!JSON.stringify(seen).includes(tmp), '죽기 전 이벤트에도 전체 경로가 없다');

  const c = await Conductor.open(deps);
  await c.settled();
  assert.ok(existsSync(wt), '작업 폴더를 지우지 않고 받아들였다');
  const branch = branchName(m.name, 'draw');
  assert.equal(sh(repo.root, 'log', '-1', '--format=%s', branch), '사무실: 중단된 작업 보관', '하던 작업을 분명한 이름으로 보관했다');
  assert.equal(sh(repo.root, 'show', `${branch}:logo.svg`), '<svg/>');
  assert.equal(c.view().tasks.draw.run.k, 'pending');

  c.input({ k: 'user_resume' });
  await m.until((es) => es.some((e) => e.k === 'settle'), 20_000);
  rig.fakes.assertClean();
  const resumed = rig.fakes.launches('claude').find((l) => l.argv.includes('sess-draw'))!;
  assert.equal(resumed.cwd, wt, '이어갈 때도 같은 작업 폴더다');
  await c.settled();
  assert.equal(sh(repo.root, 'show', `${branch}:logo.svg`), '<svg>v2</svg>');
  assert.deepEqual(snap(), before, '사용자의 체크아웃은 그대로다');
  await c.close();
  await rig.stop();
});
