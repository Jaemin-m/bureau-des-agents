import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { OfficeEvent, Quota } from '../shared/protocol.ts';
import { Normalizer, type TurnResult } from '../server/claude.ts';

// 골든 픽스처: <미션>-<n>.raw.jsonl(claude와 오간 원문)과 같은 이름의 .logged.jsonl(미션이 기록한 이벤트).
// BUREAU_RECORD=<폴더>로 녹화한 쌍을 그대로 넣으면 된다(server/record.ts).
const DIR = new URL('./fixtures/claude/', import.meta.url);

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

/** 오늘의 Normalizer에 원문 stdout을 먹이고, claude가 보낸 줄을 읽는 방식(빈 줄과 깨진 줄은 건너뜀)도 그대로 따른다. */
function normalize(raw: RawLine[], names: Set<string>, folder: string) {
  const events: OfficeEvent[] = [];
  const quotas: Quota[] = [];
  const results: TurnResult[] = [];
  const refused: string[] = [];
  const norm = new Normalizer({ emit: (ev) => events.push(ev), onQuota: (q) => quotas.push(q), onResult: (r) => results.push(r), folder, names });
  for (const { dir, line } of raw) {
    if (dir !== 'stdout' || !line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    const refuse = norm.handle(m);
    if (refuse) refused.push(refuse);
  }
  return { events, quotas, results, refused };
}

const fixture = fixtures();
test('골든 픽스처가 하나 이상 있다', () => assert.ok(fixture.length > 0));

const namesByMission = new Map<string, Set<string>>();
for (const { stem, mission } of fixture) {
  test(`Normalizer: ${stem}`, () => {
    const names = namesByMission.get(mission) ?? new Set<string>();
    namesByMission.set(mission, names);
    const recorded = jsonl<LoggedLine>(`${stem}.logged.jsonl`);
    // 서버가 직접 기록한 이벤트(start, end, file…)는 Normalizer의 몫이 아니다.
    // typing은 시계에 따라 달라지고 미션 기록에도 남기지 않는다
    const expected = recorded.filter((l) => l.from !== 'bureau').map((l) => l.ev).filter((ev) => ev.k !== 'typing');
    const got = normalize(jsonl<RawLine>(`${stem}.raw.jsonl`), names, '/work/mission').events.filter((ev) => ev.k !== 'typing');
    assert.deepEqual(got, expected);
  });
}

test('깨진 줄과 처리할 줄 모르는 제어 요청', () => {
  const raw: RawLine[] = [
    { dir: 'stdout', line: '' },
    { dir: 'stdout', line: '{깨진 줄' },
    { dir: 'stdout', line: JSON.stringify({ type: 'control_request', request_id: 'r1', request: { subtype: 'hook_callback' } }) },
    { dir: 'stdout', line: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '끝', duration_ms: 7 }) },
  ];
  const { events, results, refused } = normalize(raw, new Set(), '/work/mission');
  assert.deepEqual(events, []);
  assert.deepEqual(refused, ['r1']);
  assert.deepEqual(results, [{ ok: true, text: '끝', ms: 7, subtype: 'success' }]);
});
