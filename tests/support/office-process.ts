// 진짜 서버(server/index.ts --dev)를 자식 프로세스로 띄우고 브라우저처럼 WebSocket으로 붙는다.
// 사무실 폴더, 포트, 에이전트 실행 파일은 env로 정한다. 시나리오 테스트(가짜 CLI)와 진짜 스모크(scripts/record-cli.ts)가 함께 쓴다.
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import type { ClientMsg, OfficeEvent, ServerMsg } from '../../shared/protocol.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export interface OfficeProcess {
  port: number;
  base: string;
  msgs: ServerMsg[];
  events(): OfficeEvent[];
  send(m: ClientMsg): void;
  /** 조건이 맞을 때까지 기다린다. 시간이 다 되면 지금까지 받은 것을 담아 던진다 */
  until(pred: (msgs: ServerMsg[]) => boolean, ms: number): Promise<void>;
  /** 서버의 stdout과 stderr */
  output(): string;
  stop(): Promise<void>;
}

/** 지금 비어 있는 포트 하나(잠깐 열었다 닫는다). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

export async function spawnOffice(o: { env: NodeJS.ProcessEnv; readyMs?: number }): Promise<OfficeProcess> {
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server', 'index.ts'), '--dev'], {
    cwd: ROOT, env: { ...o.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`서버가 뜨지 않았어요:\n${out}`)), o.readyMs ?? 15_000);
    const onData = (d: Buffer) => {
      out += d.toString('utf8');
      if (out.includes('⏹')) { clearTimeout(timer); resolve(); }
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`서버가 끝났어요(코드 ${code}):\n${out}`)); });
  });
  await ready;

  const base = `http://127.0.0.1:${port}`;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://localhost:${port}` });
  const msgs: ServerMsg[] = [];
  const waiting: { pred: () => boolean; resolve: () => void }[] = [];
  ws.on('message', (data) => {
    msgs.push(JSON.parse(String(data)) as ServerMsg);
    for (const w of waiting.filter((x) => x.pred())) { waiting.splice(waiting.indexOf(w), 1); w.resolve(); }
  });
  await new Promise<void>((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });

  const events = () => msgs.flatMap((m) => (m.t === 'ev' ? [m.ev] : []));
  return {
    port, base, msgs, events, output: () => out,
    send: (m) => ws.send(JSON.stringify(m)),
    until: (pred, ms) => new Promise<void>((resolve, reject) => {
      const check = () => pred(msgs);
      if (check()) { resolve(); return; }
      const entry = { pred: check, resolve: () => { clearTimeout(timer); resolve(); } };
      const timer = setTimeout(() => {
        waiting.splice(waiting.indexOf(entry), 1);
        const toasts = msgs.flatMap((m) => (m.t === 'toast' ? [m.text] : []));
        reject(new Error(`${ms}ms 안에 조건이 맞지 않았어요. 이벤트: ${events().map((e) => e.k).join(' ')}\n알림: ${toasts.join(' | ')}\n서버:\n${out.slice(-2000)}`));
      }, ms);
      waiting.push(entry);
    }),
    stop: async () => {
      ws.close();
      if (child.exitCode !== null) return;
      const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await gone;
    },
  };
}
