// 시나리오 도우미: 진짜 서버 코드를 가짜 에이전트(CLAUDE_BIN, CODEX_BIN)로 돌리고, 나온 이벤트를 모아서 단언할 수 있게 한다.
// `openOffice`는 Bureau를 이 프로세스 안에서 돌린다(맥스의 MCP는 임시 포트). 서버 프로세스 전체는 office-process.ts가 띄운다.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AGENT_KINDS, type Logged, type OfficeEvent, type ServerMsg } from '../../shared/protocol.ts';
import { adapterFor } from '../../server/agents/registry.ts';
import { Bureau } from '../../server/bureau.ts';
import { LeadMcp } from '../../server/conductor/lead-mcp.ts';
import type { Limits } from '../../server/conductor/model.ts';
import { leadOfficeText } from '../../server/conductor/prompts.ts';
import type { ConductorDeps } from '../../server/conductor/shell.ts';
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
  /** 미션을 놓아주고(end) 기록이 다 써질 때까지 기다린다. 기록(Logged[])을 돌려준다. MCP 서버도 닫는다 */
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
  const mcp = new LeadMcp();
  const server = http.createServer((req, res) => { if (!mcp.handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const bureau = new Bureau({
    agents: await Promise.all(AGENT_KINDS.map((k) => adapterFor(k).probe())),
    broadcast: (m) => {
      msgs.push(m);
      for (const w of waiting.filter((x) => x.pred())) { waiting.splice(waiting.indexOf(w), 1); w.resolve(); }
    },
    leadMcp: mcp, mcpBase: `http://127.0.0.1:${(server.address() as { port: number }).port}`, dir: path.join(tmp, 'office'), limits: CONDUCTOR_LIMITS,
  });
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
      await bureau.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return cur?.log ?? [];
    },
    assertCheckoutUntouched() {
      assert.deepEqual(snap(), before, "the user's checkout is untouched");
    },
  };
}

// ═══════════════ 진행자(Conductor) 시나리오 ═══════════════
// Bureau를 거치지 않고 진행자를 바로 돌린다. 맥스의 MCP는 127.0.0.1의 임시 포트에 단다. 미션 여럿이 같은 서버를 쓸 수 있다.

export const CONDUCTOR_LIMITS: Partial<Limits> = { newsDebounceMs: 0, stopGraceMs: 500 };

export interface RigMission {
  name: string;
  folder: string;
  stateFile: string;
  deps: ConductorDeps;
  events(): OfficeEvent[];
  until(pred: (events: OfficeEvent[]) => boolean, ms?: number): Promise<void>;
}

export interface Rig {
  tmp: string;
  fakes: FakeAgents;
  mcp: LeadMcp;
  /** http://127.0.0.1:<port> */
  base: string;
  /** 미션 하나의 폴더, 상태 파일, 이벤트 모음. 같은 이름이면 같은 미션(다시 열 때) */
  mission(name: string): RigMission;
  stop(): Promise<void>;
}

/** 진행자 하나를 만드는 데 필요한 것. 다른 프로세스(conductor-host.ts)도 같은 것을 쓴다 */
export function conductorDeps(o: {
  missionId: string; folder: string; stateFile: string; mcp: LeadMcp; base: string; emit: (ev: OfficeEvent) => void; limits?: Partial<Limits>; repo?: ConductorDeps['repo'];
}): ConductorDeps {
  return {
    missionId: o.missionId, folder: o.folder, stateFile: o.stateFile, ...(o.repo ? { repo: o.repo } : {}), emit: o.emit, installed: ['claude'],
    settings: () => ({ autonomy: 'auto', chefModel: '', teamModel: 'sonnet', codexModel: '' }),
    leadPrompt: () => `너는 맥스다.\n\n${leadOfficeText(['claude'])}`,
    leadMcp: o.mcp, mcpBase: o.base, limits: o.limits ?? CONDUCTOR_LIMITS,
  };
}

export async function conductorRig(opts: { scripts: Partial<Record<Kind, ScriptInput>> }): Promise<Rig> {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'conductor-scenario-')));
  const fakes = fakeAgents(opts.scripts);
  const mcp = new LeadMcp();
  const server = http.createServer((req, res) => { if (!mcp.handle(req, res)) { res.writeHead(404); res.end(); } });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const missions = new Map<string, RigMission>();
  return {
    tmp, fakes, mcp, base,
    mission(name) {
      const known = missions.get(name);
      if (known) return known;
      const folder = path.join(tmp, name);
      mkdirSync(folder, { recursive: true });
      const stateFile = path.join(tmp, '.bureau', 'missions', `${name}.state.json`);
      const seen: OfficeEvent[] = [];
      const waiting: { pred: () => boolean; resolve: () => void }[] = [];
      const deps = conductorDeps({
        missionId: name, folder, stateFile, mcp, base,
        emit: (ev) => {
          seen.push(ev);
          for (const w of waiting.filter((x) => x.pred())) { waiting.splice(waiting.indexOf(w), 1); w.resolve(); }
        },
      });
      const until: RigMission['until'] = (pred, ms = TIMEOUT) => new Promise<void>((resolve, reject) => {
        const check = () => pred(seen);
        if (check()) { resolve(); return; }
        const entry = { pred: check, resolve: () => { clearTimeout(timer); resolve(); } };
        const timer = setTimeout(() => {
          waiting.splice(waiting.indexOf(entry), 1);
          const failures = fakes.launches('claude').flatMap((l) => (l.failure ? [`#${l.index}: ${l.failure}`] : []));
          reject(new Error(`${name}: ${ms}ms 안에 조건이 맞지 않았어요. 이벤트: ${seen.map((e) => e.k).join(' ')}\n${failures.join('\n')}`));
        }, ms);
        waiting.push(entry);
      });
      const m: RigMission = { name, folder, stateFile, deps, events: () => seen, until };
      missions.set(name, m);
      return m;
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
