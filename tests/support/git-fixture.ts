import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Mission, Repo } from '../../server/workspaces.ts';

const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bureau-git-')));
writeFileSync(path.join(scratch, 'empty-gitconfig'), '');
process.env.GIT_CONFIG_GLOBAL = path.join(scratch, 'empty-gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));

export function sh(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'user.name=Tester', '-c', 'user.email=t@test', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

export function write(dir: string, file: string, text: string | Buffer): void {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
}

let n = 0;

export interface Fixture {
  tmp: string;
  repo: Repo;
  mission: Mission;
  /** Records the user's checkout; the test fails unless HEAD and `status --porcelain` match this at the end. */
  freeze(): void;
  /** For the one test whose purpose is to change the checkout. */
  thaw(): void;
}

export function makeRepo(dir: string): Repo {
  mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-q', '-b', 'main');
  write(dir, 'README.md', 'hello\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'init');
  return { root: realpathSync(dir), baseBranch: 'main', baseSha: sh(dir, 'rev-parse', 'HEAD'), label: path.basename(dir) };
}

export function repoTest(name: string, body: (f: Fixture) => Promise<void>): void {
  test(name, async () => {
    const tmp = path.join(scratch, `t${++n}`);
    mkdirSync(tmp);
    process.env.BUREAU_WORKTREES = path.join(tmp, 'worktrees');
    const repo = makeRepo(path.join(tmp, 'user-repo'));
    const snap = () => ({ head: sh(repo.root, 'rev-parse', 'HEAD'), status: sh(repo.root, 'status', '--porcelain') });
    let frozen: ReturnType<typeof snap> | null = snap();
    const f: Fixture = {
      tmp, repo, mission: { id: `m${n}`, repo },
      freeze: () => { frozen = snap(); },
      thaw: () => { frozen = null; },
    };
    await body(f);
    if (frozen) assert.deepEqual(snap(), frozen, "the user's checkout is untouched");
  });
}
