// 할 일 그래프를 칠판과 패널에 보여 주는 순수 함수들: 위상 순서, 들여쓰기 깊이, 요약 숫자.
import type { TaskNode } from '../../shared/protocol.ts';
import { taskStatus, type TaskStatus } from '../../shared/tasks.ts';

export interface DagRow { key: string; title: string; depth: number; status: TaskStatus; node: TaskNode }

/** 할 일을 먼저 끝나야 하는 것부터(같은 단계에서는 들어온 순서대로) 늘어놓고, 가장 긴 선행 사슬을 깊이로 단다. 고리가 있어도 끝난다. */
export function dagRows(tasks: Readonly<Record<string, TaskNode>>): DagRow[] {
  const keys = Object.keys(tasks);
  const deps = (k: string) => tasks[k].after.filter((d) => d !== k && tasks[d]);
  const depth = new Map<string, number>();
  const depthOf = (k: string, path: Set<string>): number => {
    const known = depth.get(k);
    if (known !== undefined) return known;
    if (path.has(k)) return 0;
    path.add(k);
    let d = 0;
    for (const dep of deps(k)) d = Math.max(d, depthOf(dep, path) + 1);
    path.delete(k);
    depth.set(k, d);
    return d;
  };
  const left = new Map(keys.map((k) => [k, deps(k).length]));
  const order: string[] = [];
  const queue = keys.filter((k) => left.get(k) === 0);
  while (queue.length) {
    const k = queue.shift()!;
    order.push(k);
    for (const o of keys) {
      if (!deps(o).includes(k)) continue;
      const n = left.get(o)! - 1;
      left.set(o, n);
      if (n === 0) queue.push(o);
    }
  }
  for (const k of keys) if (!order.includes(k)) order.push(k);
  return order.map((key) => ({ key, title: tasks[key].title, depth: depthOf(key, new Set()), status: taskStatus(tasks, key), node: tasks[key] }));
}

export type DagCounts = Record<TaskStatus, number>;

export function dagCounts(rows: readonly DagRow[]): DagCounts {
  const c: DagCounts = { waiting: 0, ready: 0, running: 0, blocked: 0, done: 0, failed: 0, cancelled: 0 };
  for (const r of rows) c[r.status]++;
  return c;
}

/** 칠판에 올릴 줄: 지금 일하는 것, 곧 시작할 것, 막힌 것을 먼저 고르고 모자라면 끝난 것으로 채운 뒤, 위상 순서로 되돌려 놓는다. */
const BOARD_RANK: Record<TaskStatus, number> = { running: 0, ready: 1, blocked: 2, failed: 2, waiting: 3, done: 4, cancelled: 5 };
export function boardRows(rows: readonly DagRow[], max = 4): DagRow[] {
  const picked = rows.map((r, i) => ({ r, i })).sort((a, b) => BOARD_RANK[a.r.status] - BOARD_RANK[b.r.status] || a.i - b.i).slice(0, max);
  return picked.sort((a, b) => a.i - b.i).map((p) => p.r);
}

/** 칠판 한 줄 요약의 조각들: “대기 3 · 완료 5”가 기본이고, 있으면 진행과 실패가 붙는다(자리가 되는 만큼만 칠판이 붙인다). */
export function summaryParts(c: DagCounts): { base: string; running: string; failed: string } {
  return {
    base: `대기 ${c.waiting + c.ready + c.blocked} · 완료 ${c.done}`,
    running: c.running ? `진행 ${c.running} · ` : '',
    failed: c.failed + c.cancelled ? ` · 실패 ${c.failed + c.cancelled}` : '',
  };
}
