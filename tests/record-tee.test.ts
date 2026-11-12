import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Logged, OfficeEvent } from '../shared/protocol.ts';
import { turn, type LaunchScript } from './support/fake-agent.ts';
import { openOffice } from './support/scenario.ts';

const PROMPT = '경쟁사 한 곳을 조사해 주세요.';
const launches: LaunchScript[] = [
  {
    match: '--mcp-config ', steps: [
      ...turn({ mcp: { tool: 'office_plan', args: { tasks: [{ key: 'look', title: '경쟁사 조사', brief: 'BRIEF-LOOK 한 곳만 봐 주세요.', role: 'recherche' }] } } }, { say: { text: '맡겼어요.' } }),
      { expectInput: '모든 할 일이 끝났어요' }, { begin: true }, { say: { text: '조사가 끝났어요.' } },
    ],
  },
  { match: 'BRIEF-LOOK', steps: turn({ tool: { name: 'WebSearch', input: { query: '경쟁사' } } }, { handback: { block: { status: 'done', summary: '한 곳을 봤어요.' } } }) },
];

// 일꾼 id 끝의 무작위 글자와 걸린 시간은 실행마다 다르다
const stable = (evs: OfficeEvent[]) => JSON.parse(JSON.stringify(evs).replace(/w-(\d+)-[a-z0-9]{4}/g, 'w-$1').replace(/"ms":\d+/g, '"ms":0')) as OfficeEvent[];

async function runMission(record: boolean) {
  const office = await openOffice({ scripts: { claude: { launches } }, record });
  await office.bureau.start(PROMPT);
  const id = await office.untilDone();
  const log = await office.settle();
  office.fakes.assertClean();
  return { office, id, events: log.map((l) => l.ev) };
}

test('BUREAU_RECORD: 미션의 이벤트 하나와 세션마다 원문 하나가 남고, 켜도 미션의 기록은 그대로다', async () => {
  const withTap = await runMission(true);
  const rec = path.join(withTap.office.tmp, 'rec');
  const files = readdirSync(rec).sort();
  assert.deepEqual(files, [`${withTap.id}-1-claude.raw.jsonl`, `${withTap.id}-2-claude.raw.jsonl`, `${withTap.id}.logged.jsonl`].sort());

  const raw = readFileSync(path.join(rec, `${withTap.id}-1-claude.raw.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { dir: string; line: string });
  const stdin = raw.filter((r) => r.dir === 'stdin').map((r) => JSON.parse(r.line));
  assert.deepEqual(stdin[0], { type: 'user', message: { role: 'user', content: [{ type: 'text', text: PROMPT }] } });
  assert.ok(raw.findIndex((r) => r.dir === 'stdin') < raw.findIndex((r) => r.dir === 'stdout'), '입력이 출력보다 먼저 온다');
  const worker = readFileSync(path.join(rec, `${withTap.id}-2-claude.raw.jsonl`), 'utf8');
  assert.match(worker, /BRIEF-LOOK/, '두 번째 세션은 일꾼의 것이다');

  const logged = readFileSync(path.join(rec, `${withTap.id}.logged.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Logged);
  assert.deepEqual(logged.map((l) => l.ev), withTap.events);
  assert.deepEqual([logged[0].ev.k, logged.at(-1)?.ev.k], ['start', 'end']);

  // 변수가 없으면 같은 미션이 같은 이벤트를 기록하고, 녹화 폴더도 만들어지지 않는다
  const without = await runMission(false);
  assert.deepEqual(stable(without.events), stable(withTap.events));
  assert.equal(existsSync(path.join(without.office.tmp, 'rec')), false);
});

test('미션 기록 파일의 줄 순서는 이벤트가 일어난 순서와 같다', async () => {
  const run = await runMission(false);
  const file = path.join(run.office.dir, '.bureau', 'missions', `${run.id}.jsonl`);
  const saved = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as Logged).ev);
  assert.deepEqual(saved, run.events);
});
