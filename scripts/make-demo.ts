// 기록된 미션으로 공개 데모(public/demo/mission.json)를 만든다.
//   node scripts/make-demo.ts <미션 식별자>      (~/Documents/에이전트 사무실/.bureau/state.json 참고)
// 사용자 컴퓨터의 경로는 지운다. 데모에는 사무실 화면에 나오는 것만 남는다.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Logged, MissionInfo } from '../shared/protocol.ts';

const id = process.argv[2];
if (!id) { console.error('미션 식별자를 알려 주세요(.bureau/state.json 안에 있어요).'); process.exit(1); }
const dir = process.env.BUREAU_DIR ?? path.join(os.homedir(), 'Documents', '에이전트 사무실');
const state = JSON.parse(readFileSync(path.join(dir, '.bureau', 'state.json'), 'utf8')) as { missions: MissionInfo[] };
const mission = state.missions.find((m) => m.id === id);
if (!mission) { console.error('미션을 찾을 수 없어요: ' + id); process.exit(1); }
const log = readFileSync(path.join(dir, '.bureau', 'missions', `${id}.jsonl`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Logged);

const scrub = (s: string) => s.split(mission.folder + '/').join('').split(mission.folder).join('.').split(os.homedir()).join('~');
const clean = JSON.parse(scrub(JSON.stringify(log))) as Logged[];
const info: MissionInfo = { ...mission, folder: '미션/' + path.basename(mission.folder), sessionId: undefined, files: mission.files.map((f) => ({ ...f })) };

const out = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public', 'demo');
mkdirSync(out, { recursive: true });
writeFileSync(path.join(out, 'mission.json'), JSON.stringify({ mission: info, log: clean }));
console.log(`데모 작성 완료: public/demo/mission.json (이벤트 ${clean.length}개, ${Math.round((clean.at(-1)!.at - clean[0].at) / 1000)}초)`);
