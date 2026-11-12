import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { resolveInside } from '../server/roots.ts';

const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bureau-roots-')));
after(() => rmSync(tmp, { recursive: true, force: true }));
const root = path.join(tmp, 'mission');
const other = path.join(tmp, 'worktree');
mkdirSync(path.join(root, 'site'), { recursive: true });
mkdirSync(other);
writeFileSync(path.join(root, 'site', 'index.html'), 'hi');
writeFileSync(path.join(other, 'notes.md'), 'n');
writeFileSync(path.join(tmp, 'secret.txt'), 's');
symlinkSync(path.join(tmp, 'secret.txt'), path.join(root, 'escape.txt'));
symlinkSync(tmp, path.join(root, 'up'));
symlinkSync(path.join(root, 'site', 'index.html'), path.join(root, 'alias.html'));

test('a file inside a root resolves to its real path', async () => {
  assert.equal(await resolveInside([root], 'site/index.html'), path.join(root, 'site', 'index.html'));
  assert.equal(await resolveInside([root], path.join(root, 'site', 'index.html')), path.join(root, 'site', 'index.html'));
  assert.equal(await resolveInside([root], 'site/../site/index.html'), path.join(root, 'site', 'index.html'));
});

test('the second root is searched too', async () => {
  assert.equal(await resolveInside([root, other], path.join(other, 'notes.md')), path.join(other, 'notes.md'));
});

test('.. that leaves the root is rejected', async () => {
  assert.equal(await resolveInside([root], '../secret.txt'), null);
  assert.equal(await resolveInside([root], 'site/../../secret.txt'), null);
});

test('a symlink pointing outside the root is rejected', async () => {
  assert.equal(await resolveInside([root], 'escape.txt'), null);
  assert.equal(await resolveInside([root], 'up/secret.txt'), null);
});

test('a symlink that stays inside the root resolves to its target', async () => {
  assert.equal(await resolveInside([root], 'alias.html'), path.join(root, 'site', 'index.html'));
});

test('an absolute path outside every root, a missing file, the root itself and NUL are rejected', async () => {
  assert.equal(await resolveInside([root], path.join(tmp, 'secret.txt')), null);
  assert.equal(await resolveInside([root], 'nope.txt'), null);
  assert.equal(await resolveInside([root], '.'), null);
  assert.equal(await resolveInside([root], 'site/index.html\0'), null);
});

test('a lexical prefix is not containment', async () => {
  mkdirSync(root + '-evil');
  writeFileSync(path.join(root + '-evil', 'x.txt'), 'x');
  assert.equal(await resolveInside([root], path.join(root + '-evil', 'x.txt')), null);
});
