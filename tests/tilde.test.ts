// 화면에 보여 줄 경로는 어떤 경우에도 전체 경로가 아니다(영상에 사용자 이름이 나오지 않게).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tilde } from '../src/ui/format.ts';

test('홈 폴더 아래는 “~”로 줄인다', () => {
  assert.equal(tilde('/Users/jaemin/Documents/에이전트 사무실'), '~/Documents/에이전트 사무실');
  assert.equal(tilde('/home/jaemin/office/'), '~/office');
  assert.equal(tilde('/Users/jaemin'), '~');
  assert.equal(tilde('C:\\Users\\jaemin\\Documents\\사무실'), '~/Documents/사무실');
});

test('홈 폴더 밖의 절대 경로는 마지막 폴더 이름만 보여 준다', () => {
  assert.equal(tilde('/private/var/folders/ab/cd1234/T/에이전트 사무실'), '…/에이전트 사무실');
  assert.equal(tilde('/tmp/office-x/'), '…/office-x');
  assert.equal(tilde('/Volumes/외장/work/office'), '…/office');
  assert.equal(tilde('D:\\work\\office'), '…/office');
  assert.equal(tilde('/'), '…');
});

test('어떤 입력에서도 사용자 이름이나 중간 폴더가 나오지 않는다', () => {
  for (const p of ['/Users/jaemin/a/b', '/private/var/folders/zz/T/x', '/opt/homebrew/bin/claude', '/Users/jaemin/.local/bin/claude']) {
    const out = tilde(p);
    assert.ok(!out.includes('jaemin') && !out.includes('/private') && !out.includes('folders'), `${p} → ${out}`);
  }
});

test('상대 경로나 빈 글은 그대로 둔다', () => {
  assert.equal(tilde('미션/2026-11-12 · 제목'), '미션/2026-11-12 · 제목');
  assert.equal(tilde(''), '');
});
