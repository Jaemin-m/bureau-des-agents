// U7 진짜 스모크의 기록(진짜 서버, 진짜 claude 맥스, claude 또는 codex 일꾼 하나)을 브라우저 스토어에 접는다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Logged, MissionInfo } from '../shared/protocol.ts';
import { emptyStats } from '../shared/activity.ts';
import { loadStore } from './support/demo-fold.ts';

interface Agent { agent?: string; phase?: string; status: string; report: string }
interface View {
  agents: Record<string, Agent>; order: string[]; tasks: Record<string, { agent?: string; run: { k: string } }>;
  settled: { text: string } | null; final: { ok: boolean; text: string; ms: number } | null; files: { path: string; by: string }[];
}

for (const kind of ['claude', 'codex'] as const) {
  test(`진짜 미션(${kind} 일꾼)의 기록을 접으면 일꾼 하나, 끝난 할 일, 쓴 사람이 맞는 파일, settle과 end가 남는다`, async () => {
    const log = readFileSync(new URL(`./fixtures/scenarios/real-u7-${kind}.logged.jsonl`, import.meta.url), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l) as Logged);
    const mission: MissionInfo = {
      id: `real-u7-${kind}`, title: 'hello', prompt: '', folder: '미션/hello', createdAt: log[0].at, workMs: 0, status: 'working', stats: emptyStats(), files: [],
    };
    const { useOffice } = await loadStore();
    useOffice.setState({ replaying: true });
    useOffice.getState().resetMission(mission);
    for (const l of log) useOffice.getState().apply(l.ev, l.at, false);
    const v = useOffice.getState() as unknown as View;

    assert.equal(v.order.length, 1);
    const [id] = v.order;
    assert.equal(v.agents[id].agent, kind);
    assert.equal(v.agents[id].phase, 'retired');
    assert.ok(v.agents[id].report.includes('hello.txt'));
    assert.deepEqual(Object.values(v.tasks).map((t) => [t.agent, t.run.k]), [[kind, 'done']]);
    assert.deepEqual(v.files.map((f) => [f.path, f.by]), [['hello.txt', id]]);
    assert.ok(v.settled?.text);
    assert.equal(v.final?.ok, true);
    assert.equal(v.final?.text, v.settled?.text);
    assert.ok((v.final?.ms ?? 0) > 0);
  });
}
