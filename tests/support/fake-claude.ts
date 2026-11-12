// claude를 흉내 내는 실행 파일. 단계를 순서대로 따른다: 줄을 내보내고(emit), 입력이 n줄 올 때까지 기다리고(waitIn), 끝낸다(exit).
// child는 같은 프로세스 그룹에서 오래 사는 하위 프로세스를 띄우고 그 pid를 파일에 적는다. 단계가 끝나면 입력이 닫힐 때까지 산다. 받은 입력 줄은 inFile에 쌓는다.
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type Step = { emit: string[] } | { waitIn: number } | { exit: number } | { child: string };

const SCRIPT = `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('9.9.9 (fake)'); process.exit(0); }
const steps = JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_STEPS, 'utf8'));
const inFile = process.env.FAKE_CLAUDE_IN;
let received = 0, i = 0, buf = '';
function run() {
  while (i < steps.length) {
    const s = steps[i];
    if ('waitIn' in s) { if (received < s.waitIn) return; i++; }
    else if ('emit' in s) { for (const l of s.emit) process.stdout.write(l + '\\n'); i++; }
    else if ('child' in s) { const c = require('node:child_process').spawn('sleep', ['30'], { stdio: 'ignore' }); fs.writeFileSync(s.child, String(c.pid)); i++; }
    else { i++; process.stdout.write('', () => process.exit(s.exit)); return; }
  }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let n;
  while ((n = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, n); buf = buf.slice(n + 1);
    if (!line) continue;
    received++;
    if (inFile) fs.appendFileSync(inFile, line + '\\n');
  }
  run();
});
process.stdin.on('end', () => process.exit(0));
run();
`;

/** 가짜 claude를 만들고 CLAUDE_BIN이 그것을 가리키게 한다. 돌려주는 값: 실행 파일과, 받은 입력이 쌓이는 파일. */
export function fakeClaude(steps: Step[]) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'));
  const bin = path.join(dir, 'claude');
  const inFile = path.join(dir, 'stdin.jsonl');
  writeFileSync(bin, SCRIPT);
  chmodSync(bin, 0o755);
  writeFileSync(path.join(dir, 'steps.json'), JSON.stringify(steps));
  writeFileSync(inFile, '');
  process.env.CLAUDE_BIN = bin;
  process.env.FAKE_CLAUDE_STEPS = path.join(dir, 'steps.json');
  process.env.FAKE_CLAUDE_IN = inFile;
  return { bin, inFile, dir };
}

/** 첫 입력을 받으면 stdout 줄을 쏟아 낸다. */
export const replay = (lines: string[]): Step[] => [{ waitIn: 1 }, { emit: lines }];
