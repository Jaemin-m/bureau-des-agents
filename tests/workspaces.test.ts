import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  archive, branchName, checkpoint, checkRepo, mergeIntoBase, provision, reconcile, retire, review, worktreeRoot,
  type BranchRef, type WorkspaceRef,
} from '../server/workspaces.ts';
import { makeRepo, repoTest, sh, write, type Fixture } from './support/git-fixture.ts';

async function ready(f: Fixture, task: string, upstream: string[] = []): Promise<BranchRef> {
  const p = await provision({ mission: f.mission, task, access: 'write', upstream });
  assert.equal(p.kind, 'ready', JSON.stringify(p));
  assert.ok(p.kind === 'ready' && p.ref.kind === 'branch');
  return p.ref;
}

async function commitFile(ref: BranchRef, file: string, text: string): Promise<string> {
  write(ref.path, file, text);
  const cp = await checkpoint(ref, `${file} 추가`);
  assert.equal(cp.kind, 'committed', JSON.stringify(cp));
  return cp.kind === 'committed' ? cp.head : '';
}

const status = (dir: string) => sh(dir, 'status', '--porcelain', '--untracked-files=all');
const hasRef = (dir: string, ref: string) => spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: dir }).status === 0;

repoTest('provision twice adopts the same worktree on our branch at the base commit', async (f) => {
  const first = await provision({ mission: f.mission, task: 'build', access: 'write', upstream: [] });
  const second = await provision({ mission: f.mission, task: 'build', access: 'write', upstream: [] });
  assert.ok(first.kind === 'ready' && second.kind === 'ready');
  assert.equal(first.adopted, false);
  assert.equal(second.adopted, true);
  assert.deepEqual(second.ref, first.ref);
  assert.equal(first.ref.path, path.join(worktreeRoot(), f.mission.id, 'build'));
  assert.equal(sh(first.ref.path, 'symbolic-ref', '--short', 'HEAD'), `bureau/${f.mission.id}/build`);
  assert.equal(sh(first.ref.path, 'rev-parse', 'HEAD'), f.repo.baseSha);
});

repoTest('a crash after branch creation re-attaches the branch without resetting it', async (f) => {
  const work = sh(f.repo.root, 'commit-tree', `${f.repo.baseSha}^{tree}`, '-p', f.repo.baseSha, '-m', 'earlier run');
  sh(f.repo.root, 'branch', branchName(f.mission.id, 'build'), work);
  const ref = await ready(f, 'build');
  assert.equal(sh(ref.path, 'rev-parse', 'HEAD'), work);
});

repoTest('a crash after directory creation quarantines the folder and never deletes it', async (f) => {
  const at = path.join(worktreeRoot(), f.mission.id, 'build');
  write(at, 'half.txt', 'half written\n');
  const p = await provision({ mission: f.mission, task: 'build', access: 'write', upstream: [] });
  assert.ok(p.kind === 'ready' && p.quarantined);
  assert.match(p.quarantined, /build\.orphan-/);
  assert.equal(readFileSync(path.join(p.quarantined, 'half.txt'), 'utf8'), 'half written\n');
  assert.equal(sh(at, 'symbolic-ref', '--short', 'HEAD'), `bureau/${f.mission.id}/build`);
});

repoTest('a registered worktree whose folder vanished is re-attached with its commits', async (f) => {
  const ref = await ready(f, 'build');
  const head = await commitFile(ref, 'a.txt', 'a\n');
  rmSync(ref.path, { recursive: true });
  const again = await provision({ mission: f.mission, task: 'build', access: 'write', upstream: [] });
  assert.ok(again.kind === 'ready' && !again.adopted);
  assert.equal(sh(ref.path, 'rev-parse', 'HEAD'), head);
});

repoTest('several upstreams compose by plumbing into one start commit', async (f) => {
  const a = await ready(f, 'a');
  const b = await ready(f, 'b');
  const ha = await commitFile(a, 'a.txt', 'a\n');
  const hb = await commitFile(b, 'b.txt', 'b\n');
  const c = await ready(f, 'c', ['a', 'b']);
  assert.equal(readFileSync(path.join(c.path, 'a.txt'), 'utf8'), 'a\n');
  assert.equal(readFileSync(path.join(c.path, 'b.txt'), 'utf8'), 'b\n');
  assert.deepEqual(sh(c.path, 'rev-list', '--parents', '-n1', 'HEAD').split(' ').slice(1), [ha, hb]);
  assert.equal(status(a.path), '');
  assert.equal(status(b.path), '');
  assert.equal(sh(a.path, 'rev-parse', 'HEAD'), ha);
});

repoTest('one upstream starts from that branch head', async (f) => {
  const a = await ready(f, 'a');
  const ha = await commitFile(a, 'a.txt', 'a\n');
  const c = await ready(f, 'c', ['a']);
  assert.equal(sh(c.path, 'rev-parse', 'HEAD'), ha);
});

repoTest('conflicting upstreams return the branches and create nothing', async (f) => {
  const a = await ready(f, 'a');
  const b = await ready(f, 'b');
  await commitFile(a, 'README.md', 'from a\n');
  await commitFile(b, 'README.md', 'from b\n');
  const p = await provision({ mission: f.mission, task: 'c', access: 'write', upstream: ['a', 'b'] });
  assert.deepEqual(p, { kind: 'conflict', branches: [branchName(f.mission.id, 'a'), branchName(f.mission.id, 'b')] });
  assert.equal(existsSync(path.join(worktreeRoot(), f.mission.id, 'c')), false);
  assert.equal(hasRef(f.repo.root, `refs/heads/${branchName(f.mission.id, 'c')}`), false);
});

repoTest('a read task gets a detached lens at the base commit, never the user checkout', async (f) => {
  write(f.repo.root, 'README.md', 'user is editing\n');
  f.freeze();
  const p = await provision({ mission: f.mission, task: 'look', access: 'read', upstream: [] });
  assert.ok(p.kind === 'ready' && p.ref.kind === 'lens');
  assert.notEqual(p.ref.path, f.repo.root);
  assert.equal(spawnSync('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: p.ref.path }).status, 1, 'HEAD is detached');
  assert.equal(sh(p.ref.path, 'rev-parse', 'HEAD'), f.repo.baseSha);
  assert.equal(readFileSync(path.join(p.ref.path, 'README.md'), 'utf8'), 'hello\n');
  const again = await provision({ mission: f.mission, task: 'look', access: 'read', upstream: [] });
  assert.ok(again.kind === 'ready' && again.adopted);
});

repoTest('checkpoint commits a dirty tree with the office identity when the repo has none', async (f) => {
  const ref = await ready(f, 'build');
  write(ref.path, 'src/app.ts', 'export {};\n');
  const cp = await checkpoint(ref, '앱 뼈대');
  assert.equal(cp.kind, 'committed');
  assert.equal(sh(ref.path, 'log', '-1', '--format=%an <%ae>|%s'), '에이전트 사무실 <office@localhost>|앱 뼈대');
  assert.equal(status(ref.path), '');
});

repoTest("checkpoint uses the repo's configured identity", async (f) => {
  sh(f.repo.root, 'config', 'user.name', 'Repo Owner');
  sh(f.repo.root, 'config', 'user.email', 'owner@example.com');
  const ref = await ready(f, 'build');
  await commitFile(ref, 'x.txt', 'x\n');
  assert.equal(sh(ref.path, 'log', '-1', '--format=%an <%ae>'), 'Repo Owner <owner@example.com>');
});

repoTest('checkpoint on a clean tree commits nothing', async (f) => {
  const ref = await ready(f, 'build');
  assert.deepEqual(await checkpoint(ref, 'nothing'), { kind: 'clean', head: f.repo.baseSha });
});

repoTest('checkpoint refuses when HEAD left our branch and keeps the work as is', async (f) => {
  const ref = await ready(f, 'build');
  sh(ref.path, 'checkout', '-q', '-b', 'elsewhere');
  write(ref.path, 'w.txt', 'work\n');
  assert.deepEqual(await checkpoint(ref, 'x'), { kind: 'branchMoved' });
  assert.equal(status(ref.path), '?? w.txt');
  assert.equal(sh(f.repo.root, 'rev-parse', `refs/heads/${ref.branch}`), f.repo.baseSha);
});

repoTest('checkpoint leaves files over 5 MB unstaged and reports them', async (f) => {
  const ref = await ready(f, 'build');
  write(ref.path, 'big.bin', Buffer.alloc(5 * 1024 * 1024 + 1));
  write(ref.path, 'small.txt', 'ok\n');
  const cp = await checkpoint(ref, 'x');
  assert.ok(cp.kind === 'committed');
  assert.deepEqual(cp.skipped, [{ path: 'big.bin', why: 'large' }]);
  assert.equal(sh(ref.path, 'show', '--name-only', '--format=', 'HEAD'), 'small.txt');
  assert.equal(status(ref.path), '?? big.bin');
});

repoTest('checkpoint leaves secret-looking files unstaged and reports them', async (f) => {
  const ref = await ready(f, 'build');
  for (const s of ['.env', '.env.local', 'cert.pem', 'tls.key', 'id_rsa.pub']) write(ref.path, s, 'secret\n');
  write(ref.path, 'app.ts', 'ok\n');
  const cp = await checkpoint(ref, 'x');
  assert.ok(cp.kind === 'committed');
  assert.deepEqual(cp.skipped.map((s) => s.why), ['secret', 'secret', 'secret', 'secret', 'secret']);
  assert.equal(sh(ref.path, 'show', '--name-only', '--format=', 'HEAD'), 'app.ts');
});

repoTest('checkpoint with only held-back files commits nothing', async (f) => {
  const ref = await ready(f, 'build');
  write(ref.path, '.env', 'TOKEN=1\n');
  assert.deepEqual(await checkpoint(ref, 'x'), { kind: 'heldBack', skipped: [{ path: '.env', why: 'secret' }] });
  assert.equal(sh(ref.path, 'rev-parse', 'HEAD'), f.repo.baseSha);
});

repoTest("a failing pre-commit hook runs, leaves the tree dirty and returns the hook's output", async (f) => {
  const hook = path.join(f.repo.root, '.git', 'hooks', 'pre-commit');
  write(f.repo.root, '.git/hooks/pre-commit', '#!/bin/sh\necho "lint failed: no semicolons" >&2\nexit 1\n');
  chmodSync(hook, 0o755);
  const ref = await ready(f, 'build');
  write(ref.path, 'app.ts', 'ok\n');
  const cp = await checkpoint(ref, 'x');
  assert.ok(cp.kind === 'refused');
  assert.match(cp.output, /lint failed: no semicolons/);
  assert.equal(status(ref.path), '?? app.ts');
  assert.equal(sh(ref.path, 'rev-parse', 'HEAD'), f.repo.baseSha);
});

repoTest('retire commits leftovers, removes the folder and keeps the branch', async (f) => {
  const ref = await ready(f, 'build');
  write(ref.path, 'left.txt', 'left over\n');
  const r = await retire(ref);
  assert.equal(r.kind, 'removed');
  assert.equal(existsSync(ref.path), false);
  assert.equal(sh(f.repo.root, 'show', `refs/heads/${ref.branch}:left.txt`), 'left over');
  assert.deepEqual(await retire(ref), { kind: 'removed', checkpoint: null });
});

repoTest('retire keeps the folder when git refuses to remove it', async (f) => {
  const ref = await ready(f, 'build');
  write(ref.path, '.env', 'TOKEN=1\n');
  const r = await retire(ref);
  assert.equal(r.kind, 'retained');
  assert.equal(readFileSync(path.join(ref.path, '.env'), 'utf8'), 'TOKEN=1\n');
});

repoTest('retire keeps the folder when HEAD left our branch', async (f) => {
  const ref = await ready(f, 'build');
  sh(ref.path, 'checkout', '-q', '--detach');
  assert.equal((await retire(ref)).kind, 'retained');
  assert.ok(existsSync(ref.path));
});

repoTest('archive moves the branch to an archive ref from which it can be recovered', async (f) => {
  const ref = await ready(f, 'build');
  const head = await commitFile(ref, 'a.txt', 'a\n');
  assert.equal((await archive(ref)).kind, 'failed', 'refuses while the worktree uses the branch');
  await retire(ref);
  const a = await archive(ref);
  const archiveRef = `refs/bureau/archive/${f.mission.id}/build`;
  assert.deepEqual(a, { kind: 'archived', archiveRef });
  assert.equal(hasRef(f.repo.root, `refs/heads/${ref.branch}`), false);
  assert.equal(sh(f.repo.root, 'rev-parse', archiveRef), head);
  assert.deepEqual(await archive(ref), a, 'archiving twice is a no-op');
  sh(f.repo.root, 'branch', ref.branch, archiveRef);
  assert.equal(sh(f.repo.root, 'rev-parse', `refs/heads/${ref.branch}`), head);
});

repoTest('archive finishes after a crash between creating the archive ref and deleting the branch', async (f) => {
  const ref = await ready(f, 'build');
  const head = await commitFile(ref, 'a.txt', 'a\n');
  await retire(ref);
  sh(f.repo.root, 'update-ref', `refs/bureau/archive/${f.mission.id}/build`, head);
  assert.deepEqual(await archive(ref), { kind: 'archived', archiveRef: `refs/bureau/archive/${f.mission.id}/build` });
  assert.equal(hasRef(f.repo.root, `refs/heads/${ref.branch}`), false);
});

repoTest('a second archive of the same task never overwrites the first', async (f) => {
  const first = await ready(f, 'build');
  const h1 = await commitFile(first, 'a.txt', '1\n');
  await retire(first);
  await archive(first);
  const second = await ready(f, 'build');
  const h2 = await commitFile(second, 'a.txt', '2\n');
  await retire(second);
  assert.deepEqual(await archive(second), { kind: 'archived', archiveRef: `refs/bureau/archive/${f.mission.id}/build-2` });
  assert.equal(sh(f.repo.root, 'rev-parse', `refs/bureau/archive/${f.mission.id}/build`), h1);
  assert.equal(sh(f.repo.root, 'rev-parse', `refs/bureau/archive/${f.mission.id}/build-2`), h2);
});

repoTest('review reports the diff against base and a clean merge badge', async (f) => {
  const ref = await ready(f, 'build');
  write(ref.path, 'a.txt', 'a\nb\n');
  write(ref.path, 'README.md', 'changed\n');
  await checkpoint(ref, 'x');
  const r = await review(ref);
  assert.ok(r.kind === 'review');
  assert.deepEqual({ commits: r.commits, files: r.files, ins: r.ins, del: r.del, mergeable: r.mergeable }, { commits: 1, files: 2, ins: 3, del: 1, mergeable: 'clean' });
});

async function conflictWithBase(f: Fixture): Promise<BranchRef> {
  const ref = await ready(f, 'build');
  await commitFile(ref, 'README.md', 'from the office\n');
  write(f.repo.root, 'README.md', 'from the user\n');
  sh(f.repo.root, 'commit', '-q', '-am', 'user edit');
  f.freeze();
  return ref;
}

repoTest('review shows a conflict badge without touching anything', async (f) => {
  const ref = await conflictWithBase(f);
  const r = await review(ref);
  assert.ok(r.kind === 'review' && r.mergeable === 'conflict');
});

repoTest('mergeIntoBase merges a clean branch with --no-ff', async (f) => {
  f.thaw();
  const ref = await ready(f, 'build');
  const head = await commitFile(ref, 'a.txt', 'a\n');
  const m = await mergeIntoBase(ref);
  assert.ok(m.kind === 'merged');
  assert.deepEqual(sh(f.repo.root, 'rev-list', '--parents', '-n1', 'HEAD').split(' ').slice(1), [f.repo.baseSha, head]);
  assert.equal(readFileSync(path.join(f.repo.root, 'a.txt'), 'utf8'), 'a\n');
  assert.equal(sh(f.repo.root, 'status', '--porcelain'), '');
});

repoTest('mergeIntoBase refuses a conflicting branch', async (f) => {
  const ref = await conflictWithBase(f);
  const m = await mergeIntoBase(ref);
  assert.ok(m.kind === 'refused');
  assert.match(m.why, /충돌/);
});

repoTest('mergeIntoBase refuses a dirty checkout', async (f) => {
  const ref = await ready(f, 'build');
  await commitFile(ref, 'a.txt', 'a\n');
  write(f.repo.root, 'notes.txt', 'mine\n');
  f.freeze();
  const m = await mergeIntoBase(ref);
  assert.ok(m.kind === 'refused');
  assert.match(m.why, /저장하지 않은 변경/);
  assert.ok(!m.why.includes(f.tmp), 'names the repo by label, never by path');
});

repoTest('mergeIntoBase refuses when the checkout is on another branch', async (f) => {
  const ref = await ready(f, 'build');
  await commitFile(ref, 'a.txt', 'a\n');
  sh(f.repo.root, 'checkout', '-q', '-b', 'feature');
  f.freeze();
  const m = await mergeIntoBase(ref);
  assert.ok(m.kind === 'refused');
  assert.match(m.why, /main 브랜치에 있지 않아요/);
});

repoTest('reconcile adopts registered worktrees, quarantines strays and prunes vanished metadata', async (f) => {
  const a = await ready(f, 'a');
  const b = await ready(f, 'b');
  const lens = await provision({ mission: f.mission, task: 'look', access: 'read', upstream: [] });
  rmSync(b.path, { recursive: true });
  const stray = path.join(worktreeRoot(), f.mission.id, 'stray');
  write(stray, 'keep.txt', 'keep\n');
  const r = await reconcile(f.mission);
  assert.deepEqual(r.adopted.map((x: WorkspaceRef) => [x.task, x.kind]).sort(), [['a', 'branch'], ['look', 'lens']]);
  assert.equal(r.pruned, 1);
  assert.equal(r.quarantined.length, 1);
  assert.equal(readFileSync(path.join(r.quarantined[0], 'keep.txt'), 'utf8'), 'keep\n');
  assert.ok(hasRef(f.repo.root, `refs/heads/${b.branch}`), 'the vanished worktree keeps its branch');
  assert.ok(!sh(f.repo.root, 'worktree', 'list').includes(b.path));
  assert.ok(lens.kind === 'ready' && existsSync(lens.ref.path) && existsSync(a.path));
  assert.deepEqual(await reconcile(f.mission), { adopted: r.adopted, quarantined: [], pruned: 0 }, 'reconcile twice converges');
});

repoTest('names that are not minted ids never reach git', async (f) => {
  for (const task of ['../escape', 'Build', '-rf', 'a/b', '']) {
    const p = await provision({ mission: f.mission, task, access: 'write', upstream: [] });
    assert.equal(p.kind, 'failed', task);
  }
  const p = await provision({ mission: f.mission, task: 'ok', access: 'write', upstream: ['../x'] });
  assert.equal(p.kind, 'failed');
  assert.equal(readdirSync(path.join(worktreeRoot(), f.mission.id)).length, 0);
});

repoTest('checkRepo accepts a repo root and rejects everything else', async (f) => {
  const office = { dir: path.join(f.tmp, 'office'), home: path.join(f.tmp, 'home') };
  const ok = await checkRepo(f.repo.root, office);
  assert.deepEqual(ok, { ok: true, repo: f.repo, dirty: false });

  const no = async (p: string, why: RegExp) => {
    const r = await checkRepo(p, office);
    assert.ok(!r.ok, p);
    assert.match(r.why, why, p);
    assert.ok(!r.why.includes(f.tmp), 'never shows a full path');
  };
  await no('relative/path', /경로/);
  await no(path.join(f.tmp, 'missing'), /찾을 수 없어요/);
  await no('/', /맨 위 폴더/);
  makeRepo(office.home);
  await no(office.home, /홈 폴더/);
  makeRepo(path.join(office.dir, 'inner'));
  await no(path.join(office.dir, 'inner'), /사무실 폴더/);
  makeRepo(path.join(worktreeRoot(), 'inner'));
  await no(path.join(worktreeRoot(), 'inner'), /사무실 폴더/);
  mkdirSync(path.join(f.repo.root, 'sub'));
  await no(path.join(f.repo.root, 'sub'), /맨 위 폴더를 골라/);
  mkdirSync(path.join(f.tmp, 'plain'));
  await no(path.join(f.tmp, 'plain'), /git 저장소가 아니에요/);
  sh(f.tmp, 'clone', '-q', '--bare', f.repo.root, 'bare.git');
  await no(path.join(f.tmp, 'bare.git'), /git 저장소가 아니에요/);

  const detached = makeRepo(path.join(f.tmp, 'detached'));
  sh(detached.root, 'checkout', '-q', '--detach');
  await no(detached.root, /브랜치에 있는/);

  const merging = makeRepo(path.join(f.tmp, 'merging'));
  sh(merging.root, 'checkout', '-q', '-b', 'side');
  write(merging.root, 'README.md', 'side\n');
  sh(merging.root, 'commit', '-q', '-am', 'side');
  sh(merging.root, 'checkout', '-q', 'main');
  write(merging.root, 'README.md', 'main\n');
  sh(merging.root, 'commit', '-q', '-am', 'main');
  spawnSync('git', ['merge', 'side'], { cwd: merging.root });
  await no(merging.root, /병합 중/);

  symlinkSync(f.repo.root, path.join(f.tmp, 'link'));
  assert.deepEqual(await checkRepo(path.join(f.tmp, 'link'), office), ok, 'a symlink resolves to the real root');
});

test('the worktree root defaults outside ~/Documents and the repo', () => {
  const saved = process.env.BUREAU_WORKTREES;
  delete process.env.BUREAU_WORKTREES;
  try {
    assert.match(worktreeRoot(), /\.bureau-des-agents\/worktrees$/);
  } finally {
    process.env.BUREAU_WORKTREES = saved;
  }
});
