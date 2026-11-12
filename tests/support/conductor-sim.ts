// step을 입력 하나씩 돌리는 작은 시뮬레이터. 매 걸음마다 불변식과 멱등성(converge를 한 번 더 돌려도 아무것도 안 나옴)을 확인한다.
import assert from 'node:assert/strict';
import type { OfficeEvent } from '../../shared/protocol.ts';
import { DEFAULT_LIMITS, LEAD, busy, newMission, type Limits, type MissionState, type Opaque } from '../../server/conductor/model.ts';
import { converge, step, type Effect, type Input, type Signal, type StepCtx, type StepResult } from '../../server/conductor/step.ts';

export const ctxAt = (now: number): StepCtx => ({ now, installed: ['claude', 'codex', 'gemini'], salt: 'zz00' });

export function checkInvariants(s: MissionState) {
  const owners = new Map<string, string>();
  for (const t of Object.values(s.tasks)) {
    if (t.run.k !== 'running') continue;
    const m = s.workers[t.run.worker];
    assert.ok(m, `${t.key}: 일꾼 ${t.run.worker}가 있다`);
    assert.ok(busy(m.phase) || m.phase.k === 'blocked', `${t.key}: 돌고 있는 할 일의 일꾼 ${m.id}는 일하는 단계(${m.phase.k})`);
    assert.ok(!owners.has(m.id), `${m.id}는 할 일을 하나만 맡는다`);
    owners.set(m.id, t.key);
  }
  for (const m of Object.values(s.workers)) {
    const p = m.phase;
    if (p.k === 'provisioning' || p.k === 'starting' || p.k === 'working' || p.k === 'blocked') {
      assert.ok(owners.has(m.id), `${m.id}(${p.k})는 할 일 없이 일하지 않는다`);
    }
    if (p.k === 'blocked' && p.on.reason === 'question') assert.equal(s.questions[p.on.question]?.from, m.id);
  }
  assert.ok((s.lead.phase.k as string) !== 'provisioning');
}

export function assertConverged(s: MissionState, now: number) {
  const again = converge(s, ctxAt(now));
  assert.deepEqual(again.effects, [], 'converge를 다시 돌려도 새 효과가 없다');
  assert.deepEqual(again.events, [], 'converge를 다시 돌려도 새 이벤트가 없다');
  assert.deepEqual(again.state, s);
}

export class Sim {
  s: MissionState;
  now = 1_000;
  /** 아직 결과를 돌려주지 않은 효과 */
  open: Effect[] = [];
  events: OfficeEvent[] = [];

  constructor(limits: Partial<Limits> = {}) {
    this.s = newMission({ ...DEFAULT_LIMITS, newsDebounceMs: 0, ...limits });
  }

  do(input: Input): StepResult {
    const before = structuredClone(this.s);
    const r = step(this.s, input, ctxAt(this.now));
    assert.deepEqual(this.s, before, 'step은 받은 상태를 바꾸지 않는다');
    checkInvariants(r.state);
    assertConverged(r.state, this.now);
    this.s = r.state;
    this.events.push(...r.events);
    this.open.push(...r.effects.filter((e) => e.k !== 'persist'));
    this.now += 100;
    return r;
  }

  /** 가장 최근에 나온, 이 일꾼의 그 종류 효과를 꺼낸다. */
  take<K extends Effect['k']>(k: K, who: string): Extract<Effect, { k: K }> {
    for (let i = this.open.length - 1; i >= 0; i--) {
      const e = this.open[i];
      if (e.k === k && ('who' in e ? e.who : 'worker' in e ? e.worker : undefined) === who) {
        this.open.splice(i, 1);
        return e as Extract<Effect, { k: K }>;
      }
    }
    throw new Error(`${who}의 ${k} 효과가 없다: ${this.open.map((e) => e.key).join(', ')}`);
  }

  has(k: Effect['k'], who: string): boolean {
    return this.open.some((e) => e.k === k && ('who' in e ? e.who : 'worker' in e ? e.worker : undefined) === who);
  }

  ok(e: Effect, out?: Opaque) { return this.do({ k: 'effect_ok', effect: e, ...(out ? { out } : {}) }); }

  gen(who: string): number { return who === LEAD ? this.s.lead.gen : this.s.workers[who].gen; }

  sig(who: string, sig: Signal) { return this.do({ k: 'signal', who, gen: this.gen(who), sig }); }

  /** 맥스에게 말하고 그의 턴을 시작시킨다. */
  tellLead(text: string) {
    const r = this.do({ k: 'user_said', to: LEAD, text });
    this.beginTurn(LEAD);
    return r;
  }

  /** 대기 중인 provision·open_session·send_turn을 성공시키고 턴을 시작한다. */
  beginTurn(who: string) {
    if (this.has('provision', who)) this.ok(this.take('provision', who), { path: `/wt/${who}` });
    if (this.has('send_turn', who)) this.take('send_turn', who);
    else {
      const open = this.take('open_session', who);
      this.ok(open);
      this.sig(who, { k: 'session', ref: { id: `sess-${who}` } });
    }
    return this.sig(who, { k: 'turn_started' });
  }

  endTurn(who: string, text: string) { return this.sig(who, { k: 'turn_ended', outcome: 'ok', text }); }

  hires(): string[] { return this.events.flatMap((e) => (e.k === 'hire' ? [e.id] : [])); }

  workerFor(key: string): string {
    const t = this.s.tasks[key];
    assert.ok(t.run.k === 'running', `${key}가 돌고 있다`);
    return t.run.worker;
  }
}

export const handback = (o: unknown) => `일을 마쳤어요.\n\n\`\`\`handback\n${JSON.stringify(o)}\n\`\`\``;

/** 씨앗이 같으면 같은 수열(mulberry32). rnd(n)은 0..n-1. */
export function random(seed: number): (n: number) => number {
  let a = seed >>> 0;
  return (n) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) % 4294967296) % n;
  };
}
