// npm run dev: 브리지(자동 재시작)와 Vite(핫 리로드)를 함께 띄운다.
import { spawn } from 'node:child_process';

const procs = [
  spawn(process.execPath, ['--watch-path=server', '--watch-path=shared', 'server/index.ts', '--dev'], { stdio: 'inherit' }),
  spawn('npx', ['vite'], { stdio: 'inherit', shell: process.platform === 'win32' }),
];
const stop = () => { for (const p of procs) p.kill('SIGINT'); setTimeout(() => process.exit(0), 800); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => { if (code) stop(); });
