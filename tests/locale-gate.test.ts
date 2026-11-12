import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

test('날짜와 숫자는 한국어로 쓴다: 로케일을 받는 호출은 모두 ko-KR이다', () => {
  const bad: string[] = [];
  for (const file of ['src', 'server', 'shared'].flatMap((d) => sources(path.join(ROOT, d)))) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/\b(?:toLocale(?:String|DateString|TimeString)|Intl\.\w+)\(\s*'([^']+)'/g)) {
        if (m[1] !== 'ko-KR') bad.push(`${path.relative(ROOT, file)}:${i + 1} ${m[1]}`);
      }
    });
  }
  assert.deepEqual(bad, []);
});
