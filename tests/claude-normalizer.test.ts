import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { OfficeEvent, Quota } from '../shared/protocol.ts';
import type { SessionSpec } from '../server/agents/adapter.ts';
import { openLegacyLead, type TurnResult } from '../server/agents/registry.ts';
import { fakeAgents } from './support/fake-agent.ts';

// 골든 픽스처: <미션>-<n>.raw.jsonl(claude와 오간 원문)과 같은 이름의 .logged.jsonl(미션이 기록한 이벤트).
// BUREAU_RECORD=<폴더>로 녹화한 쌍을 그대로 넣으면 된다(server/record.ts).
const DIR = new URL('./fixtures/claude/', import.meta.url);
const MISSION = '/work/mission';

interface RawLine { dir: 'stdout' | 'stdin'; line: string }
interface LoggedLine { at: number; ev: OfficeEvent; from?: 'normalizer' | 'bureau' }

const jsonl = <T>(name: string) => readFileSync(new URL(name, DIR), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T);

/** 같은 미션의 프로세스는 이름 목록을 함께 쓴다(미션 안에서 로봇 이름은 겹치지 않는다): 번호 순서로 돌린다. */
function fixtures() {
  const pairs = readdirSync(DIR).filter((f) => f.endsWith('.raw.jsonl')).map((f) => {
    const stem = f.slice(0, -'.raw.jsonl'.length);
    const m = /^(.*)-(\d+)$/.exec(stem);
    assert.ok(m, `${f}: 이름은 <미션>-<번호>.raw.jsonl이어야 해요`);
    return { stem, mission: m[1], n: Number(m[2]) };
  });
  return pairs.sort((a, b) => a.mission.localeCompare(b.mission) || a.n - b.n);
}

/**
 * 픽스처의 stdout 줄을 가짜 claude로 흘려 보낸다: 진짜 어댑터의 프로세스 껍데기(줄 읽기, 깨진 줄 건너뛰기, 모르는 제어 요청 거절)와
 * 레거시 번역기를 그대로 지난다. 픽스처의 미션 폴더(/work/mission)는 실제로 있는 임시 폴더로 바꿔 읽는다.
 */
async function viaAdapter(raw: RawLine[], names: Set<string>, expectReplies = 0) {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'bureau-golden-'));
  const lines = raw.filter((r) => r.dir === 'stdout').map((r) => r.line.replaceAll(MISSION, folder));
  const fake = fakeAgents({ claude: [{ expectInput: {} }, { emit: lines }, { expectControl: expectReplies }, { exit: 0 }] });
  const events: OfficeEvent[] = [];
  const quotas: Quota[] = [];
  const results: TurnResult[] = [];
  const spec: SessionSpec = { cwd: folder, powers: { tools: [], preapproved: [] }, access: 'write', autonomy: 'auto', systemPrompt: '' };
  await new Promise<void>((resolve) => {
    openLegacyLead(spec, { text: '시작' }, '{}', {
      emit: (ev) => events.push(ev), onQuota: (q) => quotas.push(q), onResult: (r) => results.push(r), onExit: () => resolve(), names,
    });
  });
  const replies = fake.launches('claude')[0].stdin.slice(1).map((l) => JSON.parse(l));
  return { events, quotas, results, replies, folder };
}

const fixture = fixtures();
test('골든 픽스처가 하나 이상 있다', () => assert.ok(fixture.length > 0));

const namesByMission = new Map<string, Set<string>>();
for (const { stem, mission } of fixture) {
  test(`레거시 번역기: ${stem}`, async () => {
    const names = namesByMission.get(mission) ?? new Set<string>();
    namesByMission.set(mission, names);
    const recorded = jsonl<LoggedLine>(`${stem}.logged.jsonl`);
    const run = await viaAdapter(jsonl<RawLine>(`${stem}.raw.jsonl`), names);
    const swap = (ev: OfficeEvent) => JSON.parse(JSON.stringify(ev).replaceAll(MISSION, run.folder)) as OfficeEvent;
    // 서버가 직접 기록한 이벤트(start, end, file…)는 번역기의 몫이 아니다.
    // typing은 시계에 따라 달라지고 미션 기록에도 남기지 않는다
    const expected = recorded.filter((l) => l.from !== 'bureau').map((l) => swap(l.ev)).filter((ev) => ev.k !== 'typing');
    assert.deepEqual(run.events.filter((ev) => ev.k !== 'typing'), expected);
  });
}

test('깨진 줄과 처리할 줄 모르는 제어 요청', async () => {
  const raw: RawLine[] = [
    { dir: 'stdout', line: '' },
    { dir: 'stdout', line: '{깨진 줄' },
    { dir: 'stdout', line: JSON.stringify({ type: 'control_request', request_id: 'r1', request: { subtype: 'hook_callback' } }) },
    { dir: 'stdout', line: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '끝', duration_ms: 7 }) },
  ];
  const { events, results, replies } = await viaAdapter(raw, new Set(), 1);
  assert.deepEqual(events, []);
  assert.deepEqual(replies.map((r) => [r.type, r.response?.subtype, r.response?.request_id]), [['control_response', 'error', 'r1']]);
  assert.deepEqual(results, [{ ok: true, text: '끝', ms: 7, subtype: 'success' }]);
});
