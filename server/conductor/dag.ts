// office_plan 검사. 전부 받거나 전부 거절한다. 오류는 맥스가 읽고 바로 고칠 수 있는 짧은 한국어 문장이다.
import { AGENT_KINDS, type AgentKind } from '../../shared/protocol.ts';
import { ROLES } from '../../shared/activity.ts';
import type { Access, MemberRole, MissionState, TaskKey, TaskSpec, WorkerId } from './model.ts';

/** office_plan의 할 일 하나. MCP 층이 JSON 모양만 맞춰서 넘긴다. */
export interface PlanSpec { key: string; title: string; brief: string; role: string; agent?: string; access?: string; after?: readonly string[]; pin?: string }

export type PlanCheck = { ok: true; specs: TaskSpec[] } | { ok: false; errors: string[] };

const KEY = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MEMBER_ROLES = (Object.keys(ROLES) as (keyof typeof ROLES)[]).filter((r): r is MemberRole => r !== 'chef');
const TITLE_MAX = 60;
const BRIEF_MAX = 6000;

const same = (a: TaskSpec, b: TaskSpec) =>
  a.title === b.title && a.brief === b.brief && a.role === b.role && a.agent === b.agent && a.access === b.access &&
  a.pin === b.pin && a.after.length === b.after.length && a.after.every((k, i) => k === b.after[i]);

/**
 * 받을 할 일(새것과 고친 것)을 돌려준다. 이미 있는 키와 똑같은 할 일은 빼고(잃어버린 응답을 다시 보낸 것),
 * 아직 시작하지 않은 키는 고치고, 시작한 키를 바꾸려 하면 거절한다.
 */
export function validatePlan(s: MissionState, specs: readonly PlanSpec[], installed: readonly AgentKind[]): PlanCheck {
  const errors: string[] = [];
  if (!specs.length) return { ok: false, errors: ['할 일이 하나도 없어요. tasks에 하나 이상 넣어 주세요.'] };
  const seen = new Set<string>();
  const out: TaskSpec[] = [];
  for (const p of specs) {
    const at = `할 일 '${p.key}'`;
    if (!KEY.test(p.key)) { errors.push(`키 '${p.key}'는 영어 소문자, 숫자, -로 32자까지만 쓸 수 있어요.`); continue; }
    if (seen.has(p.key)) { errors.push(`키 '${p.key}'가 두 번 나와요. 키마다 하나만 보내 주세요.`); continue; }
    seen.add(p.key);
    if (!p.title.trim() || p.title.length > TITLE_MAX) errors.push(`${at}의 title은 1~${TITLE_MAX}자로 써 주세요.`);
    if (!p.brief.trim() || p.brief.length > BRIEF_MAX) errors.push(`${at}의 brief는 1~${BRIEF_MAX}자로 써 주세요.`);
    if (!MEMBER_ROLES.includes(p.role as MemberRole)) errors.push(`${at}의 role '${p.role}'는 없어요. 고를 수 있는 것: ${MEMBER_ROLES.join(', ')}.`);
    const agent = (p.agent ?? 'claude') as AgentKind;
    if (!AGENT_KINDS.includes(agent)) errors.push(`${at}의 agent '${p.agent}'는 없어요. 고를 수 있는 것: ${AGENT_KINDS.join(', ')}.`);
    else if (!installed.includes(agent)) errors.push(`${at}의 agent '${agent}'는 이 컴퓨터에 깔려 있지 않아요. 깔린 것: ${installed.join(', ') || '없음'}.`);
    const access = (p.access ?? 'write') as Access;
    if (access !== 'read' && access !== 'write') errors.push(`${at}의 access는 read 또는 write예요.`);
    if (p.pin !== undefined) {
      const w = s.workers[p.pin];
      if (!w || w.phase.k === 'retired') errors.push(`${at}의 pin '${p.pin}' 일꾼은 없거나 이미 떠났어요.`);
    }
    out.push({
      key: p.key as TaskKey, title: p.title.trim(), brief: p.brief, role: p.role as MemberRole, agent, access,
      after: [...new Set(p.after ?? [])] as TaskKey[], ...(p.pin !== undefined ? { pin: p.pin as WorkerId } : {}),
    });
  }
  if (errors.length) return { ok: false, errors };

  const fresh = out.filter((spec) => {
    const t = s.tasks[spec.key];
    if (!t) return true;
    if (same(t, spec)) return false;
    if (t.run.k !== 'pending' || t.turns > 0 || t.seat !== undefined) {
      errors.push(`할 일 '${spec.key}'는 이미 시작해서 바꿀 수 없어요. 새 키로 계획해 주세요.`);
      return false;
    }
    return true;
  });
  const graph = new Map<string, readonly string[]>(Object.values(s.tasks).map((t) => [t.key, t.after]));
  for (const spec of fresh) graph.set(spec.key, spec.after);
  for (const spec of fresh) for (const dep of spec.after) {
    if (!graph.has(dep)) errors.push(`할 일 '${spec.key}'가 없는 할 일 '${dep}'를 기다려요.`);
  }
  if (graph.size > s.limits.maxTasks) errors.push(`할 일은 미션마다 ${s.limits.maxTasks}개까지예요. 지금 ${graph.size}개가 돼요.`);
  if (errors.length) return { ok: false, errors };

  const stuck = cycleKeys(graph);
  if (stuck.length) return { ok: false, errors: [`할 일이 서로를 기다려서 영영 시작할 수 없어요: ${stuck.slice(0, 10).join(', ')}.`] };
  return { ok: true, specs: fresh };
}

/** Kahn 정렬 뒤에 남은 키: 고리에 있거나 고리를 기다리는 할 일. */
function cycleKeys(graph: ReadonlyMap<string, readonly string[]>): string[] {
  const indeg = new Map<string, number>();
  const next = new Map<string, string[]>();
  for (const [k, after] of graph) {
    indeg.set(k, after.length);
    for (const d of after) next.set(d, [...(next.get(d) ?? []), k]);
  }
  const queue = [...graph.keys()].filter((k) => indeg.get(k) === 0);
  for (let k = queue.pop(); k !== undefined; k = queue.pop()) {
    for (const n of next.get(k) ?? []) {
      const d = indeg.get(n)! - 1;
      indeg.set(n, d);
      if (d === 0) queue.push(n);
    }
  }
  return [...indeg].filter(([, d]) => d > 0).map(([k]) => k).sort();
}
