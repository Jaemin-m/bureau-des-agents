// CLI 프로세스를 띄우고 한 줄씩 읽는 공통 부분: 자기 프로세스 그룹에서 돌고, 멈출 때 그룹 전체를 멈춘다.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';

export interface Launch { bin: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }
export interface ExitInfo { code: number | null; signal: string | null; stderrTail: string }

const STDERR_TAIL = 4000;
const STOP_GRACE_MS = 5000;

/** 한 줄의 JSON. 빈 줄과 깨진 줄은 null. */
export function parseJsonLine(line: string): Record<string, any> | null {
  if (!line.trim()) return null;
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}

export class Proc {
  private p: ChildProcessWithoutNullStreams;
  private stderr = '';
  private done = false;
  private exitWaiters: (() => void)[] = [];

  constructor(launch: Launch, onLine: (line: string) => void, onExit: (e: ExitInfo) => void) {
    // detached = 새 프로세스 그룹: claude가 띄운 하위 프로세스까지 한 번에 멈출 수 있다
    const p = spawn(launch.bin, launch.args, { cwd: launch.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    this.p = p;
    readline.createInterface({ input: p.stdout }).on('line', onLine);
    p.stderr.on('data', (b: Buffer) => { this.stderr = (this.stderr + b.toString()).slice(-STDERR_TAIL); });
    const finish = (code: number | null, signal: string | null) => {
      if (this.done) return;
      this.done = true;
      onExit({ code, signal, stderrTail: this.stderr });
      for (const w of this.exitWaiters) w();
    };
    // “close”는 출력을 끝까지 읽은 뒤에 온다(“exit”와 다르다)
    p.on('close', finish);
    // 실행할 수 없다(삭제됨, 실행 권한 없음…): 오류로 끝난다
    p.on('error', (e) => { this.stderr += String(e); finish(1, null); });
    p.stdin.on('error', () => { /* 프로세스가 이미 끝났다: “close”가 처리한다 */ });
  }

  get alive() { return !this.done; }
  get pid() { return this.p.pid; }

  write(line: string) {
    if (this.done) return false;
    this.p.stdin.write(line + '\n');
    return true;
  }

  /** 입력을 닫고, 5초 안에 안 끝나면 그룹을 멈춘다. 프로세스가 사라지면 끝난다. */
  stop(): Promise<void> {
    if (this.done) return Promise.resolve();
    const exited = new Promise<void>((resolve) => this.exitWaiters.push(resolve));
    this.p.stdin.end();
    const timer = setTimeout(() => this.kill(), STOP_GRACE_MS);
    timer.unref();
    return exited.then(() => clearTimeout(timer));
  }

  /** 프로세스 그룹 전체에 SIGTERM. */
  kill() {
    if (this.done) return;
    try {
      if (this.p.pid && process.platform !== 'win32') process.kill(-this.p.pid, 'SIGTERM');
      else this.p.kill('SIGTERM');
    } catch { /* 이미 끝났다 */ }
  }
}
