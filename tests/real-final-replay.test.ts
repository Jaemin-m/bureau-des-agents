// 최종 진짜 스모크의 기록(진짜 서버, 진짜 claude 맥스와 claude 일꾼, 의존하는 codex 일꾼, 이어서 시키기, 합치기)을 브라우저 스토어에 접는다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Logged, MissionInfo, TaskNode } from '../shared/protocol.ts';
import { emptyStats } from '../shared/activity.ts';
import { loadStore } from './support/demo-fold.ts';

interface View {
  agents: Record<string, { agent?: string; phase?: string }>; order: string[]; tasks: Record<string, TaskNode>;
  settled: { text: string } | null; final: { ok: boolean; text: string } | null; files: { path: string; by: string }[];
}

test('진짜 저장소 미션의 기록을 접으면 의존하는 두 할 일과 이어서 한 일이 같은 브랜치로 남고, 합친 표시가 모두 붙고, 마지막 settle이 이어서 한 일을 안다', async () => {
  const log = readFileSync(new URL('./fixtures/scenarios/real-final-repo.logged.jsonl', import.meta.url), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l) as Logged);
  const mission: MissionInfo = {
    id: 'real-final-repo', title: '메모', prompt: '', folder: '미션/메모', createdAt: log[0].at, workMs: 0, status: 'working', stats: emptyStats(), files: [],
    target: { kind: 'repo', label: 'repo', baseBranch: 'main' },
  };
  const { useOffice } = await loadStore();
  useOffice.setState({ replaying: true });
  useOffice.getState().resetMission(mission);
  for (const l of log) useOffice.getState().apply(l.ev, l.at, false);
  const v = useOffice.getState() as unknown as View;

  assert.deepEqual(v.order.map((id) => v.agents[id].agent), ['claude', 'codex'], '일꾼은 둘: claude 다음 codex');
  assert.ok(v.order.every((id) => v.agents[id].phase === 'retired'));
  const done = (key: string) => { const t = v.tasks[key]; return t.run.k === 'done' ? t.run.result : assert.fail(`${key}는 끝나지 않았다`); };
  const [readme, notes] = [done('readme'), done('notes')];
  assert.deepEqual(v.tasks.notes.after, ['readme'], '두 번째 할 일은 첫 번째에 기댄다');
  assert.deepEqual([v.tasks.readme.agent, v.tasks.notes.agent], ['claude', 'codex']);
  assert.match(readme.branch!, /^bureau\/[^/]+\/readme$/);
  assert.match(notes.branch!, /^bureau\/[^/]+\/notes$/);

  const followKeys = Object.keys(v.tasks).filter((k) => k.startsWith('f.'));
  assert.equal(followKeys.length, 1, '이어서 시킨 일은 하나');
  const follow = done(followKeys[0]);
  assert.equal(follow.branch, notes.branch, '이어서 한 일은 codex 일꾼의 같은 브랜치에서 했다');
  assert.equal(follow.by, notes.by);
  assert.equal(notes.merged, true);
  assert.equal(follow.merged, true, '이어서 한 일도 합친 것으로 표시된다');
  assert.ok(!readme.merged, '합치지 않은 다른 브랜치는 그대로다');

  assert.equal(log.filter((l) => l.ev.k === 'settle').length, 2, '맥스는 처음과 이어서 한 뒤에 한 번씩 마무리했다');
  assert.ok(v.settled?.text.includes('codex again'), '마지막 마무리 글이 이어서 한 일을 안다');
  assert.equal(v.final?.ok, true);
});
