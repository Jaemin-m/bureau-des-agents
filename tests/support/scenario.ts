// 시나리오 도우미: 진짜 서버 코드를 가짜 에이전트(CLAUDE_BIN, CODEX_BIN)로 돌리고, 나온 이벤트를 모아서 단언할 수 있게 한다.
// 지금은 Bureau(오늘의 서버)를 감싼다. 컨덕터로 넘어가면 이 파일의 `openOffice` 안쪽만 바뀌고 부르는 쪽은 그대로다.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Logged, OfficeEvent, ServerMsg } from '../../shared/protocol.ts';
import { adapterFor } from '../../server/agents/registry.ts';
import { Bureau } from '../../server/bureau.ts';
import type { Repo } from '../../server/workspaces.ts';
import { fakeAgents, type FakeAgents, type Kind, type ScriptInput } from './fake-agent.ts';
import { makeRepo, sh } from './git-fixture.ts';

export interface OpenOptions {
  /** CLI마다 대본. 준 CLI만 CLAUDE_BIN, CODEX_BIN이 가짜를 가리킨다 */
  scripts: Partial<Record<Kind, ScriptInput>>;
  /** 임시 git 저장소를 하나 만든다(사용자의 체크아웃 역할) */
  repo?: boolean;
  /** BUREAU_RECORD 폴더를 임시 폴더 안에 둔다 */
  record?: boolean;
}

const TIMEOUT = 8000;

export interface Office {
  tmp: string;
  /** 사무실 폴더(미션과 기록이 쌓인다) */
  dir: string;
  fakes: FakeAgents;
  repo?: Repo;
  bureau: Bureau;
  msgs: ServerMsg[];
  /** 지금까지 방송된 이벤트 */
  events(): OfficeEvent[];
  /** 조건이 맞을 때까지 기다린다. 시간이 다 되면 지금까지의 이벤트 종류를 담아 던진다 */
  until(pred: (events: OfficeEvent[], msgs: ServerMsg[]) => boolean, ms?: number): Promise<void>;
  /** 미션이 끝났다(status done)는 방송까지 기다리고 미션 번호를 돌려준다 */
  untilDone(ms?: number): Promise<string>;
  /** 미션을 정리한다: 팀장 프로세스를 내리고 기록이 다 써질 때까지 기다린다. 기록(Logged[])을 돌려준다 */
  settle(): Promise<Logged[]>;
  /** repo가 있을 때: 사용자의 체크아웃(HEAD와 status)이 처음 그대로인지 확인한다 */
  assertCheckoutUntouched(): void;
}

export async function openOffice(opts: OpenOptions): Promise<Office> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'bureau-scenario-'));
  const fakes = fakeAgents(opts.scripts);
  if (opts.record) process.env.BUREAU_RECORD = path.join(tmp, 'rec'); else delete process.env.BUREAU_RECORD;

  let repo: Repo | undefined;
  if (opts.repo) {
    process.env.BUREAU_WORKTREES = path.join(tmp, 'worktrees');
    repo = makeRepo(path.join(tmp, 'user-repo'));
  }
  const snap = () => (repo ? { head: sh(repo.root, 'rev-parse', 'HEAD'), status: sh(repo.root, 'status', '--porcelain') } : null);
  const before = snap();

  const msgs: ServerMsg[] = [];
  const waiting: { pred: () => boolean; resolve: () => void }[] = [];
  const events = () => msgs.flatMap((m) => (m.t === 'ev' ? [m.ev] : []));
  const bureau = new Bureau(await adapterFor('claude').probe(), (m) => {
    msgs.push(m);
    for (const w of waiting.filter((x) => x.pred())) { waiting.splice(waiting.indexOf(w), 1); w.resolve(); }
  }, path.join(tmp, 'office'));
  await bureau.init();

  const until: Office['until'] = (pred, ms = TIMEOUT) => new Promise<void>((resolve, reject) => {
    const check = () => pred(events(), msgs);
    if (check()) { resolve(); return; }
    const entry = { pred: check, resolve: () => { clearTimeout(timer); resolve(); } };
    const timer = setTimeout(() => {
      waiting.splice(waiting.indexOf(entry), 1);
      reject(new Error(`${ms}ms 안에 조건이 맞지 않았어요. 이벤트: ${events().map((e) => e.k).join(' ')}`));
    }, ms);
    waiting.push(entry);
  });

  return {
    tmp, dir: bureau.dir, fakes, repo, bureau, msgs, events, until,
    async untilDone(ms) {
      await until((_e, m) => m.some((x) => x.t === 'mission' && x.mission.status === 'done'), ms);
      const done = msgs.find((x): x is Extract<ServerMsg, { t: 'mission' }> => x.t === 'mission' && x.mission.status === 'done');
      return done!.mission.id;
    },
    async settle() {
      const cur = bureau.current;
      if (!cur) return [];
      const log = cur.log;
      cur.live?.lead.session.kill();
      for (let i = 0; i < 100 && cur.live; i++) await new Promise((r) => setTimeout(r, 20));
      bureau.close();
      await cur.writes;
      return log;
    },
    assertCheckoutUntouched() {
      assert.deepEqual(snap(), before, "the user's checkout is untouched");
    },
  };
}
