import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Logged } from '../shared/protocol.ts';
import { openOffice } from './support/scenario.ts';

const FIXTURE = new URL('./fixtures/claude/hand-minimal-1.raw.jsonl', import.meta.url);
const stdoutLines = readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { dir: string; line: string }).filter((r) => r.dir === 'stdout').map((r) => r.line);

async function runMission(record: boolean) {
  const office = await openOffice({ scripts: { claude: [{ expectInput: {} }, { emit: stdoutLines }] }, record });
  await office.bureau.start('경쟁사 한 곳을 조사해 주세요.');
  const id = await office.untilDone();
  const log = await office.settle();
  return { office, id, events: log.map((l) => l.ev) };
}

test('BUREAU_RECORD: 원문과 이벤트가 쌍으로 남고, 켜도 미션의 기록은 그대로다', async () => {
  const withTap = await runMission(true);
  const rec = path.join(withTap.office.tmp, 'rec');
  const files = readdirSync(rec).sort();
  assert.deepEqual(files, [`${withTap.id}-1.logged.jsonl`, `${withTap.id}-1.raw.jsonl`]);

  const raw = readFileSync(path.join(rec, files[1]), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { dir: string; line: string });
  assert.deepEqual(raw.filter((r) => r.dir === 'stdout').map((r) => r.line), stdoutLines);
  const stdin = raw.filter((r) => r.dir === 'stdin');
  assert.equal(stdin.length, 1);
  assert.deepEqual(JSON.parse(stdin[0].line), { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '경쟁사 한 곳을 조사해 주세요.' }] } });
  assert.ok(raw.findIndex((r) => r.dir === 'stdin') < raw.findIndex((r) => r.dir === 'stdout'), '입력이 출력보다 먼저 온다');

  const logged = readFileSync(path.join(rec, files[0]), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Logged & { from: string });
  assert.deepEqual(logged.map((l) => l.ev), withTap.events);
  assert.equal(logged[0].from, 'bureau');
  assert.equal(logged.find((l) => l.ev.k === 'init')?.from, 'normalizer');
  assert.equal(logged.at(-1)?.ev.k, 'end');

  // 변수가 없으면 같은 미션이 같은 이벤트를 기록하고, 녹화 폴더도 만들어지지 않는다
  const without = await runMission(false);
  assert.deepEqual(without.events, withTap.events);
  assert.equal(existsSync(path.join(without.office.tmp, 'rec')), false);
});

test('미션 기록 파일의 줄 순서는 이벤트가 일어난 순서와 같다', async () => {
  const run = await runMission(false);
  const file = path.join(run.office.dir, '.bureau', 'missions', `${run.id}.jsonl`);
  const saved = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as Logged).ev);
  assert.deepEqual(saved, run.events);
});
