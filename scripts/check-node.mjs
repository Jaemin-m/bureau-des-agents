// 사무실을 실행하기 전에: 알맞은 Node 버전과 Claude Code 설치를 확인한다.
import { execFileSync } from 'node:child_process';
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < 22 || (maj === 22 && min < 18)) {
  console.error(`\n  에이전트 사무실은 Node.js 22.18 이상이 필요해요(지금 버전: ${process.versions.node}).`);
  console.error('  https://nodejs.org 에서 최신 버전을 설치한 뒤 “npm start”를 다시 실행해 주세요.\n');
  process.exit(1);
}
try {
  execFileSync('claude', ['--version'], { stdio: 'ignore', timeout: 15000 });
} catch {
  console.warn('\n  ⚠  Claude Code를 찾을 수 없어요. 사무실이 데모로 열려요.');
  console.warn('  Claude Code를 설치하고(https://claude.com/claude-code), “claude”로 로그인한 뒤 “npm start”를 다시 실행해 주세요.\n');
}
