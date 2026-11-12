// 서버가 갑자기 죽었다가 다시 켜진다: 진행자를 다른 프로세스에서 돌리다 SIGKILL하고, 같은 상태 파일로 새 진행자를 연다.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { OfficeEvent } from '../shared/protocol.ts';
import { loadSaved } from '../server/conductor/boot.ts';
import { Conductor } from '../server/conductor/shell.ts';
import { turn, type LaunchScript } from './support/fake-agent.ts';
import { conductorRig } from './support/scenario.ts';

const HOST = fileURLToPath(new URL('./support/conductor-host.ts', import.meta.url));

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const userTexts = (stdin: string[]) => stdin.map((l) => JSON.parse(l) as { type: string; message?: { content: { text: string }[] } })
  .filter((m) => m.type === 'user').map((m) => m.message!.content[0].text);

test('죽었다 켜지기: 남은 프로세스 그룹을 끝내고, 할 일은 pending, 미션은 stopped, 사용자가 이어가면 한 번씩만 전한다', { timeout: 60_000 }, async (t) => {
  const childPid = path.join(mkdtempSync(path.join(os.tmpdir(), 'conductor-child-')), 'child.pid');
  const launches: LaunchScript[] = [
    {
      match: '^(?![\\s\\S]*--resume)(?=[\\s\\S]*--mcp-config )', session: 'sess-lead',
      steps: turn({ mcp: { tool: 'office_plan', args: { tasks: [{ key: 'draw', title: '그림', brief: 'BRIEF-DRAW 가게 로고를 그려 주세요.', role: 'design' }] } } }, { say: { text: '맡겼어요.' } }),
    },
    { match: 'BRIEF-DRAW', session: 'sess-draw', steps: turn({ child: { pidFile: childPid } }, { tool: { name: 'Write', input: { file_path: 'logo.svg' } } }, { hang: true }) },
    { match: '--resume sess-draw', steps: [{ expectInput: '멈췄던 일을 이어서 해 주세요' }, { begin: true }, { handback: { block: { status: 'done', summary: 'SUMMARY-DRAW logo.svg' } } }] },
    { match: '--resume sess-lead', steps: [{ expectInput: 'SUMMARY-DRAW[\\s\\S]*모든 할 일이 끝났어요' }, { begin: true }, { say: { text: '로고를 다 그렸어요.' } }] },
  ];
  const rig = await conductorRig({ scripts: { claude: { launches } } });
  const m = rig.mission('restart');
  const opening = 'OPENING 가게 로고를 만들어 주세요.';

  const host = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', HOST], {
    env: { ...process.env, CONDUCTOR_HOST: JSON.stringify({ missionId: m.name, folder: m.folder, stateFile: m.stateFile, opening }) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const before: OfficeEvent[] = [];
  readline.createInterface({ input: host.stdout }).on('line', (l) => before.push(JSON.parse(l) as OfficeEvent));
  const exited = new Promise((r) => host.on('close', r));
  for (let i = 0; i < 400 && !(existsSync(childPid) && before.some((e) => e.k === 'act' && e.tool === 'Write')); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(existsSync(childPid), '일꾼이 일하는 중이다');
  host.kill('SIGKILL');
  await exited;

  const saved = loadSaved(m.stateFile);
  assert.ok(saved, '상태 파일이 남아 있다');
  const worker = Object.keys(saved.mission.workers)[0];
  const workerPid = saved.procs[worker]?.pid;
  const sleepPid = Number(readFileSync(childPid, 'utf8'));
  // 단언이 실패해도 남은 프로세스가 테스트 실행을 붙잡지 않게 한다
  t.after(() => { for (const pid of [workerPid, sleepPid]) if (pid && alive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* 이미 끝났다 */ } } } });
  assert.ok(workerPid && alive(workerPid) && alive(sleepPid), '서버가 죽어도 일꾼과 그 하위 프로세스는 살아 있다');
  assert.equal(saved.mission.tasks.draw.run.k, 'running');

  const c = await Conductor.open(m.deps);
  assert.ok(!alive(workerPid) && !alive(sleepPid), '남은 프로세스 그룹을 끝냈다');
  assert.equal(c.view().status, 'stopped');
  assert.equal(c.view().tasks.draw.run.k, 'pending');
  assert.equal(c.view().workers[worker].phase.k, 'idle');
  assert.ok(m.events().some((e) => e.k === 'worker' && e.id === worker && e.phase === 'idle' && e.note), '멈춘 까닭을 알린다');
  assert.deepEqual(loadSaved(m.stateFile)!.procs, {}, '쥔 프로세스가 없다');

  c.input({ k: 'user_resume' });
  await m.until((es) => es.some((e) => e.k === 'settle'));
  rig.fakes.assertClean();
  assert.equal(c.view().tasks.draw.run.k, 'done');

  const said = rig.fakes.launches('claude').flatMap((l) => userTexts(l.stdin));
  assert.equal(said.filter((t) => t.includes('OPENING')).length, 1, '첫 요청은 한 번만 전한다');
  assert.equal(said.filter((t) => t.includes('BRIEF-DRAW')).length, 1, '지시는 한 번만 전한다');
  assert.equal(said.filter((t) => t.includes('멈췄던 일을 이어서')).length, 1, '이어가기는 한 번만 전한다');
  assert.equal(said.filter((t) => t.includes('SUMMARY-DRAW')).length, 1, '소식은 한 번만 전한다');
  assert.equal(m.events().filter((e) => e.k === 'report').length, 1);
  await c.close();
  await rig.stop();
});
