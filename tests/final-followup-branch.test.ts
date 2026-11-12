// 진짜 스모크(최종)에서 찾은 두 가지: 끝난 브랜치의 일꾼에게 이어서 시킨 일이
// (1) 맥스에게 "만들지 않은 할 일"로 보였고, (2) 원래 할 일을 합쳐도 이어서 한 일은 합치지 않은 것으로 남았다.
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { OfficeEvent, ServerMsg, TaskNode } from '../shared/protocol.ts';
import { branchName } from '../server/workspaces.ts';
import { fakeAgents, turn, type LaunchScript, type Step } from './support/fake-agent.ts';
import { makeRepo, sh } from './support/git-fixture.ts';
import { spawnOffice } from './support/office-process.ts';

const LEAD = '^(?![\\s\\S]*--resume)(?=[\\s\\S]*--mcp-config )';
const PLAN = { tasks: [{ key: 'notes', title: '메모 쓰기', brief: 'BRIEF-NOTES NOTES.md를 만들어 주세요.', role: 'code' }] };
const anyTurn = (n: number): Step[] => Array.from({ length: n }, (_, i) => [{ expectInput: '.' }, { begin: true }, { say: { text: `맥스의 말 ${i + 1}` } }] as Step[]).flat();
const lastTask = (es: OfficeEvent[], key: string) => es.filter((e): e is Extract<OfficeEvent, { k: 'task' }> => e.k === 'task' && e.key === key).at(-1) as TaskNode | undefined;

test('끝난 브랜치의 일꾼에게 이어서 시키면 맥스는 사용자가 시킨 일로 알고, 원래 할 일을 합치면 이어서 한 일도 합친 것이 된다', { timeout: 60_000 }, async () => {
  const done = (summary: string): Step => ({ handback: { block: { status: 'done', summary } } });
  const launches: LaunchScript[] = [
    { match: LEAD, session: 'sess-lead', steps: [...turn({ mcp: { tool: 'office_plan', args: PLAN } }, { say: { text: '맡겼어요.' } }), ...anyTurn(4)] },
    { match: 'BRIEF-NOTES', session: 'sess-notes', steps: turn({ writeFile: { path: 'NOTES.md', content: 'one\n' } }, done('SUMMARY-ONE')) },
    {
      match: '--resume sess-notes',
      steps: turn({ writeFile: { path: 'NOTES.md', content: 'two\n', append: true } }, done('SUMMARY-TWO')),
    },
    { match: '--resume sess-lead', steps: [{ expectInput: '사용자가 .*이어서 시킨' }, { begin: true }, { say: { text: '이어서 한 일을 확인했어요.' } }] },
  ];
  const fakes = fakeAgents({ claude: { launches } });
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'followup-branch-')));
  const repo = makeRepo(path.join(tmp, 'user-repo'));
  const env: NodeJS.ProcessEnv = { ...process.env, BUREAU_DIR: path.join(tmp, 'office'), BUREAU_WORKTREES: path.join(tmp, 'worktrees'), CLAUDE_BIN: fakes.bin.claude };
  delete env.BUREAU_RECORD;
  delete env.CODEX_BIN;
  const office = await spawnOffice({ env });
  const settles = () => office.events().filter((e) => e.k === 'settle').length;
  const toast = (m: ServerMsg[], re: RegExp) => m.some((x) => x.t === 'toast' && re.test(x.text));
  try {
    await office.until((m) => m.some((x) => x.t === 'hello'), 5000);
    office.send({ t: 'start', prompt: '메모를 써 주세요.', target: { repo: repo.root } });
    await office.until(() => settles() >= 1, 30_000);
    const worker = office.events().find((e) => e.k === 'hire')!.id;
    const id = office.msgs.filter((x): x is Extract<ServerMsg, { t: 'mission' }> => x.t === 'mission').at(-1)!.mission.id;

    office.send({ t: 'say', text: 'NOTES.md에 한 줄 더 덧붙여 주세요.', to: worker });
    await office.until(() => settles() >= 2, 30_000);
    fakes.assertClean();
    const follow = office.events().find((e): e is Extract<OfficeEvent, { k: 'task' }> => e.k === 'task' && e.key.startsWith('f.'))!;
    const branch = branchName(id, 'notes');
    const tip = sh(repo.root, 'rev-parse', branch);
    const result = (key: string) => { const t = lastTask(office.events(), key); return t?.run.k === 'done' ? { branch: t.run.result.branch, head: t.run.result.head } : null; };
    assert.deepEqual(result(follow.key), { branch, head: tip }, '이어서 한 일은 같은 브랜치의 새 끝을 가리킨다');

    office.send({ t: 'merge', taskKey: 'notes' });
    await office.until((m) => toast(m, /합쳤어요/), 5000);
    for (const key of ['notes', follow.key]) {
      await office.until(() => { const t = lastTask(office.events(), key); return t?.run.k === 'done' && t.run.result.merged === true; }, 5000);
    }
    assert.equal(sh(repo.root, 'show', 'HEAD:NOTES.md'), 'one\ntwo', '합친 것에 이어서 한 일이 들어 있다');
  } finally {
    await office.stop();
  }
});
