// 할 일 그래프에서 계산하는 값. 저장하는 건 실행 기록(run)뿐이고, 나머지는 모두 여기서 나온다.
// 순수 함수만 둔다: 브라우저(스토어)와 서버가 같은 답을 내야 한다.
import type { TaskNode, TaskRun } from './protocol.ts';

export type TaskStatus = 'waiting' | 'ready' | 'running' | 'blocked' | 'done' | 'failed' | 'cancelled';

export type TaskGraph = Readonly<Record<string, Pick<TaskNode, 'after' | 'run'>>>;

const RUN_STATUS: Record<Exclude<TaskRun['k'], 'pending'>, TaskStatus> = {
  running: 'running', done: 'done', failed: 'failed', cancelled: 'cancelled',
};

/**
 * 아직 시작하지 않은 할 일: 먼저 할 일이 모두 끝났으면 ready, 하나라도 실패·취소·막힘이면 blocked, 아니면 waiting.
 * 아직 모르는 키는 waiting이다(기록에서 그 할 일이 나중에 올 수 있다). 고리는 영영 시작할 수 없으니 blocked.
 */
export function taskStatus(tasks: TaskGraph, key: string): TaskStatus {
  return statusOf(tasks, key, new Map(), new Set());
}

function statusOf(tasks: TaskGraph, key: string, memo: Map<string, TaskStatus>, path: Set<string>): TaskStatus {
  const t = tasks[key];
  if (!t) return 'waiting';
  if (t.run.k !== 'pending') return RUN_STATUS[t.run.k];
  const known = memo.get(key);
  if (known) return known;
  if (path.has(key)) return 'blocked';
  path.add(key);
  let status: TaskStatus = 'ready';
  for (const dep of t.after) {
    const s = statusOf(tasks, dep, memo, path);
    if (s === 'failed' || s === 'cancelled' || s === 'blocked') { status = 'blocked'; break; }
    if (s !== 'done') status = 'waiting';
  }
  path.delete(key);
  memo.set(key, status);
  return status;
}

/** 일꾼이 지금 맡은 할 일: run이 그 일꾼을 가리키는 할 일. */
export function taskOf(tasks: Readonly<Record<string, TaskNode>>, worker: string): TaskNode | undefined {
  return Object.values(tasks).find((t) => t.run.k === 'running' && t.run.worker === worker);
}
