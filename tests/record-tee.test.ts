import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Logged, ServerMsg } from '../shared/protocol.ts';
import { Bureau } from '../server/bureau.ts';

const FIXTURE = new URL('./fixtures/claude/hand-minimal-1.raw.jsonl', import.meta.url);
const stdoutLines = readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { dir: string; line: string }).filter((r) => r.dir === 'stdout').map((r) => r.line);

// claude를 흉내 내는 실행 파일: 첫 입력 줄을 받으면 픽스처의 stdout을 그대로 쏟고, 입력이 닫힐 때까지 산다
const FAKE = `#!/usr/bin/env node
const fs = require('node:fs');
const lines = JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_OUT, 'utf8'));
let sent = false;
process.stdin.on('data', () => { if (sent) return; sent = true; for (const l of lines) process.stdout.write(l + '\\n'); });
process.stdin.on('end', () => process.exit(0));
`;

const TIMEOUT = 8000;

async function runMission(tmp: string, record: string | undefined) {
  const bin = path.join(tmp, 'fake-claude');
  const out = path.join(tmp, 'out.json');
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
  writeFileSync(out, JSON.stringify(stdoutLines));
  process.env.FAKE_CLAUDE_OUT = out;
  if (record) process.env.BUREAU_RECORD = record; else delete process.env.BUREAU_RECORD;

  let finished: (id: string) => void = () => {};
  const done = new Promise<string>((resolve) => { finished = resolve; });
  const bureau = new Bureau({ path: bin, version: 'fake' }, (m: ServerMsg) => { if (m.t === 'mission' && m.mission.status === 'done') finished(m.mission.id); }, path.join(tmp, 'office'));
  await bureau.init();
  await bureau.start('경쟁사 한 곳을 조사해 주세요.');
  const timer = setTimeout(() => finished(''), TIMEOUT);
  const id = await done;
  clearTimeout(timer);
  assert.ok(id, '가짜 claude의 미션이 끝나지 않았어요');

  const cur = bureau.current!;
  const log = cur.log;
  const proc = cur.live!;
  proc.stopping = true;
  proc.proc.kill();
  for (let i = 0; i < 100 && cur.live; i++) await new Promise((r) => setTimeout(r, 20));
  bureau.close();
  await cur.writes;
  return { id, events: log.map((l) => l.ev) };
}

test('BUREAU_RECORD: 원문과 이벤트가 쌍으로 남고, 켜도 미션의 기록은 그대로다', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'bureau-tee-'));
  const rec = path.join(tmp, 'rec');
  const withTap = await runMission(tmp, rec);
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
  const tmp2 = mkdtempSync(path.join(os.tmpdir(), 'bureau-tee-'));
  const without = await runMission(tmp2, undefined);
  assert.deepEqual(without.events, withTap.events);
  assert.equal(existsSync(path.join(tmp2, 'rec')), false);
});

test('미션 기록 파일의 줄 순서는 이벤트가 일어난 순서와 같다', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'bureau-order-'));
  const run = await runMission(tmp, undefined);
  const file = path.join(tmp, 'office', '.bureau', 'missions', `${run.id}.jsonl`);
  const saved = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as Logged).ev);
  assert.deepEqual(saved, run.events);
});
