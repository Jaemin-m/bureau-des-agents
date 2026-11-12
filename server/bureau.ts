// 서버 쪽 사무실. 진짜 폴더 ~/Documents/에이전트 사무실/ 안에 산다.
//   - “사무실 규칙.md”: 팀이 사용자에 대해 알아야 할 것(맥스가 미션마다 먼저 읽는다).
//   - “미션/”: 미션마다 폴더 하나. 팀이 만든 모든 것을 여기에 둔다.
//   - “.bureau/”(숨김): 사무실 상태와 미션마다의 기록(다시 재생용).
// 미션 하나 = 진행자(server/conductor/shell.ts) 하나. 진행자가 맥스와 일꾼의 프로세스, 할 일, 질문을 쥐고,
// 이 파일은 미션 목록, 설정, 기록, 미션 폴더의 파일과 버전을 쥔다. 미션이 쉬는 중(settle)에도 다시 말을 걸 수 있고
// (수정 요청), 그러면 맥스가 같은 세션을 이어간다.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { appendFile, copyFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { countStats, emptyStats } from '../shared/activity.ts';
import type { AgentInfo, AgentKind, ClaudeInfo, FileInfo, Logged, MissionInfo, OfficeEvent, Quota, Role, ServerMsg, Settings, TeamEntry, VersionInfo } from '../shared/protocol.ts';
import type { AdapterProbe } from './agents/adapter.ts';
import { loadSaved, reapOrphans } from './conductor/boot.ts';
import { LEAD_LENS } from './conductor/dag.ts';
import type { LeadMcp } from './conductor/lead-mcp.ts';
import { LEAD, type Limits } from './conductor/model.ts';
import { leadPrompt } from './conductor/prompts.ts';
import { Conductor, type ConductorDeps, type UserInput } from './conductor/shell.ts';
import { openRecorder, type Recorder } from './record.ts';
import { resolveInside } from './roots.ts';
import { changedFiles, checkRepo, provision, reconcile, retire, type RepoCheck } from './workspaces.ts';

const RULES_FILE = '사무실 규칙.md';

const RULES_TEMPLATE = `# 사무실 규칙

팀장 맥스는 미션마다 이 파일을 먼저 읽어요. 팀이 나에 대해 알아야 할 것을
새 동료에게 설명하듯 내 말로 편하게 적어 주세요.

## 나는 누구인가요
<!-- 예: “저는 알렉스예요. 부산에서 퍼스널 트레이너로 일해요. 30~45세 여성에게 온라인 운동 프로그램을 팔아요.” -->

## 나를 위해 일하는 방법
- 한국어로, 쉽게 답해 주세요.
- 바로 본론으로 가 주세요. 바로 쓸 수 있는 결과물을 원해요.
- 모든 것을 미션 폴더에, 알아보기 쉬운 파일 이름으로 정리해 주세요.
`;

const README = `# 에이전트 사무실

여기서 내 AI 에이전트 팀(Claude Code 에이전트)이 일해요.

- “사무실 규칙.md”: 팀이 나에 대해 알아야 할 것. 팀장 맥스가 미션마다 먼저 읽어요.
- “미션”: 미션마다 폴더 하나. 팀이 만든 모든 것(보고서, 웹 페이지, 글)이 여기에 정리돼요.

숨김 폴더 “.bureau”에는 사무실 상태와 미션마다의 기록이 있어서 다시 재생할 수 있어요.
처음부터 다시 시작하고 싶으면 이 폴더를 지워도 돼요.
`;

const DEFAULT_SETTINGS: Settings = { chefModel: 'sonnet', teamModel: 'sonnet', permission: 'auto', codexModel: '' };
const CHEF_MODELS = ['', 'sonnet', 'opus', 'haiku', 'fable'];
const TEAM_MODELS = ['sonnet', 'haiku', 'opus', 'fable', 'inherit'];
/** codex의 모델 이름은 목록이 없어서 모양만 본다('' = codex의 기본값) */
const CODEX_MODEL = /^[\w.:-]{0,64}$/;
const MAX_LOG = 8000;
const MAX_MISSIONS = 300;
/** 이보다 큰 파일은 버전을 남기지 않는다(동영상, 큰 내보내기 파일) */
const MAX_VERSION_SIZE = 5_000_000;
const MAX_VERSIONS = 30;

/** 파일 버전을 모아 둘 안전한 폴더 이름(한글 파일 이름은 그대로 둔다). */
const versionDirName = (rel: string) => rel.replace(/[\\/]+/g, '__').replace(/[^\w.\-À-ÿ\u3131-\u318E\uAC00-\uD7A3 ]+/g, '_').slice(0, 160);

interface State { missions: MissionInfo[]; settings: Settings }

interface Current {
  mission: MissionInfo;
  log: Logged[];
  /** Conductor.create가 돌아오기 전(첫 이벤트들이 나오는 동안)에만 null */
  conductor: Conductor | null;
  watcher: FSWatcher | null;
  fileTimers: Map<string, NodeJS.Timeout>;
  /** 팀이 언제부터 일하고 있는지(null = 쉬는 중) */
  busySince: number | null;
  /** 파일의 전체 경로 → 마지막으로 Write·Edit한 일꾼 */
  writers: Map<string, string>;
  /** 일꾼마다 일한 시간대 [시작, 끝]. Bash로 만든 파일은 쓴 사람이 이벤트에 없어서 파일의 수정 시각으로 찾는다 */
  spans: Map<string, [number, number][]>;
  /** 개발용 녹화(BUREAU_RECORD) */
  rec: Recorder | null;
  /** 기록 파일 쓰기를 한 줄로 잇는다. 따로 쏘면 줄 순서가 뒤바뀌어 다시 보기가 틀어진다 */
  writes: Promise<void>;
  /** 저장소 미션만: 작업 폴더의 바뀐 파일을 git status로 살핀다(node_modules가 있는 저장소를 fs.watch로 통째로 보지 않는다) */
  poll: NodeJS.Timeout | null;
  polling: boolean;
  /** 마지막으로 살핀 시각. 미션이 쉬기 시작한 뒤에도 한 번은 더 살핀다 */
  polledAt: number;
}

const POLL_MS = 1200;

export interface BureauOptions {
  /** 깔린 CLI마다 어댑터의 probe 결과 */
  agents: readonly AdapterProbe[];
  broadcast: (m: ServerMsg) => void;
  /** 서버에 단 맥스의 MCP 끝점과 그 서버의 주소(http://127.0.0.1:<포트>) */
  leadMcp: LeadMcp;
  mcpBase: string;
  dir?: string;
  limits?: Partial<Limits>;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 요청에서 뽑은 짧은 제목: “경쟁사 5곳을 분석하고 랜딩 페이지도…” → “경쟁사 5곳을 분석하고 랜딩 페이지도” */
function titleOf(prompt: string) {
  const first = prompt.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0] ?? '';
  let t = first.replace(/[.!?:;,]+$/, '');
  if (t.length > 46) t = t.slice(0, 46).replace(/\s+\S*$/, '') + '…';
  return t ? t[0].toUpperCase() + t.slice(1) : '미션';
}

const cleanName = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');

/** 예시 주석을 뺀 사무실 규칙 내용. */
function readRules(dir: string) {
  try {
    return readFileSync(path.join(dir, RULES_FILE), 'utf8').replace(/<!--[\s\S]*?-->/g, '').slice(0, 20000);
  } catch { return ''; }
}

export class Bureau {
  readonly dir: string;
  readonly missionsDir: string;
  private stateFile: string;
  private recDir: string;
  private verDir: string;
  private state: State = { missions: [], settings: { ...DEFAULT_SETTINGS } };
  private saveTimer: NodeJS.Timeout | null = null;
  current: Current | null = null;
  quota: Quota | null = null;

  private agents: readonly AdapterProbe[];
  private installed: AgentKind[];
  private broadcast: (m: ServerMsg) => void;
  private leadMcp: LeadMcp;
  private mcpBase: string;
  private limits: Partial<Limits> | undefined;

  constructor(o: BureauOptions) {
    this.agents = o.agents;
    this.installed = o.agents.filter((a) => a.found).map((a) => a.kind);
    this.broadcast = o.broadcast;
    this.leadMcp = o.leadMcp;
    this.mcpBase = o.mcpBase;
    this.limits = o.limits;
    this.dir = o.dir ?? path.join(os.homedir(), 'Documents', '에이전트 사무실');
    this.missionsDir = path.join(this.dir, '미션');
    this.stateFile = path.join(this.dir, '.bureau', 'state.json');
    this.recDir = path.join(this.dir, '.bureau', 'missions');
    this.verDir = path.join(this.dir, '.bureau', 'versions');
  }

  async init() {
    const fresh = !existsSync(this.dir);
    await mkdir(this.recDir, { recursive: true });
    await mkdir(this.missionsDir, { recursive: true });
    if (fresh) await writeFile(path.join(this.dir, '읽어 주세요.md'), README);
    if (!existsSync(path.join(this.dir, RULES_FILE))) await writeFile(path.join(this.dir, RULES_FILE), RULES_TEMPLATE);
    if (existsSync(this.stateFile)) {
      try {
        const s = JSON.parse(await readFile(this.stateFile, 'utf8')) as Partial<State>;
        this.state = { missions: Array.isArray(s.missions) ? s.missions : [], settings: { ...DEFAULT_SETTINGS, ...(s.settings ?? {}) } };
      } catch { /* 상태를 읽을 수 없으면 깨끗하게 새로 시작한다 */ }
    }
    // “작업 중”으로 남은 미션(실행 중에 사무실이 꺼졌다)은 중단 상태로 바꾸고, 그 미션이 남긴 프로세스를 끝낸다
    for (const m of this.state.missions) {
      if (m.status !== 'working') continue;
      m.status = 'stopped';
      const saved = loadSaved(this.stateFileOf(m.id));
      if (saved) await reapOrphans(Object.values(saved.procs));
      // 저장소 미션의 작업 폴더는 지우지 않는다: 주인 없는 폴더만 옆으로 옮기고, 사라진 폴더의 기록을 정리한다
      if (saved?.repo) await reconcile({ id: m.id, repo: saved.repo }).catch(() => {});
    }
  }

  /** 사용자가 고른 저장소를 확인한다. 미션을 바꾸지 않고 기록하지도 않는다. */
  async repoCheck(userPath: string): Promise<RepoCheck> {
    const p = userPath.trim();
    const abs = p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
    return checkRepo(abs, { dir: this.dir, home: os.homedir() });
  }

  private stateFileOf(missionId: string) { return path.join(this.recDir, `${missionId}.state.json`); }

  claudeInfo(): ClaudeInfo {
    const c = this.agents.find((a) => a.kind === 'claude');
    return c?.found ? { found: true, version: c.version, path: c.path } : { found: false };
  }

  agentInfo(): AgentInfo[] {
    return this.agents.map((a) => ({ kind: a.kind, found: a.found, ...(a.version ? { version: a.version } : {}) }));
  }

  get settings() { return this.state.settings; }

  setSettings(p: Partial<Settings>) {
    const cur = this.state.settings;
    this.state.settings = {
      chefModel: typeof p.chefModel === 'string' && CHEF_MODELS.includes(p.chefModel) ? p.chefModel : cur.chefModel,
      teamModel: typeof p.teamModel === 'string' && TEAM_MODELS.includes(p.teamModel) ? p.teamModel : cur.teamModel,
      permission: p.permission === 'ask' || p.permission === 'auto' ? p.permission : cur.permission,
      codexModel: typeof p.codexModel === 'string' && CODEX_MODEL.test(p.codexModel) ? p.codexModel : cur.codexModel ?? '',
    };
    this.save();
    this.broadcast({ t: 'settings', settings: this.state.settings });
  }

  missions(): MissionInfo[] {
    return [...this.state.missions].sort((a, b) => b.createdAt - a.createdAt).slice(0, 60);
  }

  hello(): ServerMsg {
    const c = this.current;
    return {
      t: 'hello', claude: this.claudeInfo(), agents: this.agentInfo(), dir: this.dir, settings: this.settings, quota: this.quota,
      missions: this.missions(), current: c ? { mission: c.mission, log: c.log } : null,
    };
  }

  private mission(id: string) { return this.state.missions.find((m) => m.id === id) ?? null; }

  // ── 새 미션 ──
  /** 새 미션. target.repo가 있으면 그 git 저장소에서 일한다(사용자의 체크아웃은 건드리지 않는다). */
  async start(prompt: string, target?: { repo: string }) {
    const text = prompt.trim();
    if (!text) throw new Error('맥스에게 원하는 걸 말해 주세요.');
    if (!this.installed.includes('claude')) throw new Error('이 컴퓨터에 Claude Code가 설치되어 있지 않아요.');
    if (this.current?.mission.status === 'working') throw new Error('팀이 이미 미션을 하고 있어요. 끝날 때까지 기다리거나 멈춰 주세요.');

    const id = 'm' + Date.now().toString(36);
    let repo: ConductorDeps['repo'];
    if (target) {
      const check = await this.repoCheck(target.repo);
      if (!check.ok) throw new Error(check.why);
      const mission = { id, repo: check.repo };
      const lens = await provision({ mission, task: LEAD_LENS, access: 'read', upstream: [] });
      if (lens.kind !== 'ready' || lens.ref.kind !== 'lens') throw new Error('맥스가 저장소를 읽을 폴더를 준비하지 못했어요.');
      repo = { mission, lead: lens.ref };
    }
    if (this.current) await this.close();

    const now = new Date();
    const title = titleOf(text);
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}시 ${pad(now.getMinutes())}분`;
    let folder = path.join(this.missionsDir, cleanName(`${stamp} · ${title.replace(/…$/, '')}`).slice(0, 90));
    for (let n = 2; existsSync(folder); n++) folder = path.join(this.missionsDir, cleanName(`${stamp} · ${title.replace(/…$/, '')} ${n}`).slice(0, 90));
    await mkdir(folder, { recursive: true });

    const r = repo?.mission.repo;
    const mission: MissionInfo = {
      id, title, prompt: text, folder, createdAt: Date.now(), workMs: 0,
      status: 'working', stats: emptyStats(), files: [], target: r ? { kind: 'repo', label: r.label, baseBranch: r.baseBranch } : { kind: 'folder' },
    };
    this.state.missions.push(mission);
    if (this.state.missions.length > MAX_MISSIONS) this.state.missions.splice(0, this.state.missions.length - MAX_MISSIONS);
    this.save();
    const cur: Current = {
      mission, log: [], conductor: null, watcher: null, fileTimers: new Map(), busySince: Date.now(), writers: new Map(), spans: new Map(),
      rec: openRecorder(mission.id), writes: Promise.resolve(), poll: null, polling: false, polledAt: 0,
    };
    this.current = cur;
    this.watch(cur);
    if (repo) cur.poll = setInterval(() => void this.pollWorktrees(cur), POLL_MS);
    this.broadcast({ t: 'mission', mission });
    try {
      cur.conductor = Conductor.create(this.deps(cur, repo), text);
    } catch (e) {
      if (repo) await retire(repo.lead);
      this.settleMission(cur, 'error');
      throw e;
    }
    this.sync(cur);
  }

  private deps(cur: Current, repo: ConductorDeps['repo']): ConductorDeps {
    const m = cur.mission;
    const rec = cur.rec;
    const r = repo?.mission.repo;
    return {
      missionId: m.id, folder: m.folder, stateFile: this.stateFileOf(m.id), ...(repo ? { repo } : {}),
      emit: (ev) => this.onEvent(cur, ev),
      journal: (line) => {
        const file = path.join(this.recDir, `${m.id}.journal.txt`);
        cur.writes = cur.writes.then(() => appendFile(file, `${new Date().toISOString()} ${line}\n`)).catch(() => {});
      },
      onQuota: (q) => { this.quota = q; this.broadcast({ t: 'quota', quota: q }); },
      installed: this.installed,
      settings: () => {
        const s = this.settings;
        return { autonomy: s.permission === 'ask' ? 'ask' : 'auto', chefModel: s.chefModel, teamModel: s.teamModel, codexModel: s.codexModel ?? '' };
      },
      leadPrompt: () => leadPrompt(readRules(this.dir), this.installed, r ? { label: r.label, baseBranch: r.baseBranch } : undefined),
      leadMcp: this.leadMcp, mcpBase: this.mcpBase,
      ...(this.limits ? { limits: this.limits } : {}),
      ...(rec ? { tap: (kind: AgentKind) => rec.session(kind) } : {}),
    };
  }

  /** 지금 미션의 진행자에게 브라우저의 입력을 넣는다. */
  private send(input: UserInput, quiet = false) {
    const cur = this.current;
    const c = cur?.conductor;
    if (!cur || !c) throw new Error('먼저 미션을 시작해 주세요.');
    const r = c.input(input);
    this.sync(cur);
    if (!r.ok && !quiet) throw new Error(r.error);
  }

  /** 맥스(to가 없을 때)나 일꾼 한 명에게 말하기. 쉬거나 멈춘 미션이면 다시 일하기 시작한다. */
  say(text: string, to?: string) {
    const clean = text.trim();
    if (clean) this.send({ k: 'user_said', to: to || LEAD, text: clean });
  }

  /** 일꾼의 질문(ask kind:'question')에 답한다. */
  reply(requestId: string, text: string) {
    const clean = text.trim();
    if (clean) this.send({ k: 'user_replied', questionId: requestId, text: clean });
  }

  /** 멈춘 일꾼과 맥스를 모두 다시 일하게 한다. */
  resume() { this.send({ k: 'user_resume' }); }

  private conductor(): Conductor {
    const c = this.current?.conductor;
    if (!c) throw new Error('먼저 미션을 시작해 주세요.');
    return c;
  }

  /** 지금 합칠 수 있으면 null, 아니면 그 이유. 사용자의 체크아웃을 바꾸지 않는다. */
  mergeCheck(taskKey: string): Promise<string | null> { return this.conductor().mergeCheck(taskKey); }

  /** 사용자가 브라우저에서 누른 “합치기”. 맥스에게는 없는 길이다. */
  async merge(taskKey: string): Promise<string> {
    const r = await this.conductor().merge(taskKey);
    if (!r.ok) throw new Error(r.error);
    return r.text ?? '합쳤어요.';
  }

  /** “버리기”: 브랜치를 지우지 않고 보관 ref로 옮긴다. */
  async discard(taskKey: string): Promise<string> {
    const r = await this.conductor().discard(taskKey);
    if (this.current) this.sync(this.current);
    if (!r.ok) throw new Error(r.error);
    return r.text ?? '버렸어요.';
  }

  private onEvent(cur: Current, ev: OfficeEvent) {
    const m = cur.mission;
    this.sync(cur);
    if (ev.k === 'init') { m.model = ev.model; this.save(); }
    if (ev.k === 'act' && (ev.kind === 'write' || ev.kind === 'edit') && ev.detail) cur.writers.set(path.resolve(m.folder, ev.detail), ev.who);
    if (ev.k === 'worker' && ev.id !== LEAD) trackSpan(cur.spans, ev.id, ev.phase === 'working');
    // 진행자는 쉬는 동안을 뺀 미션의 작업 시간을 모른다: 그건 여기서 센다
    if (ev.k === 'end') ev = { ...ev, ms: m.workMs };
    countStats(m.stats, ev);
    this.record(cur, ev);
    if (ev.k === 'hire') this.save();
  }

  /** 진행자의 미션 상태를 미션 목록에 옮긴다(작업 시간, 끝난 시각, 맥스의 마지막 말). */
  private sync(cur: Current) {
    const s = cur.conductor?.view();
    if (s && s.status !== cur.mission.status) this.settleMission(cur, s.status, s.leadLast);
  }

  private settleMission(cur: Current, status: MissionInfo['status'], final?: string) {
    const m = cur.mission;
    const now = Date.now();
    if (status === 'working') {
      m.endedAt = undefined;
      cur.busySince = now;
    } else {
      m.endedAt = now;
      if (cur.busySince) m.workMs += now - cur.busySince;
      cur.busySince = null;
      if (final) m.final = final.slice(0, 20000);
    }
    m.status = status;
    this.broadcast({ t: 'mission', mission: m });
    this.save();
  }

  private record(cur: Current, ev: OfficeEvent) {
    const at = Date.now();
    this.broadcast({ t: 'ev', missionId: cur.mission.id, at, ev });
    if (ev.k === 'typing') return; // 기록하기엔 너무 잦다
    cur.rec?.logged({ at, ev });
    cur.log.push({ at, ev });
    if (cur.log.length > MAX_LOG) cur.log.splice(0, cur.log.length - MAX_LOG);
    const file = path.join(this.recDir, `${cur.mission.id}.jsonl`);
    const line = JSON.stringify({ at, ev }) + '\n';
    cur.writes = cur.writes.then(() => appendFile(file, line)).catch(() => {});
  }

  // ── 팀이 만든 파일 ──
  private watch(cur: Current) {
    const folder = cur.mission.folder;
    try {
      cur.watcher = watch(folder, { recursive: true }, (_type, name) => {
        if (!name) return;
        const rel = String(name);
        if (rel.split(path.sep).some((p) => p.startsWith('.') || p === 'node_modules')) return;
        const prev = cur.fileTimers.get(rel);
        if (prev) clearTimeout(prev);
        cur.fileTimers.set(rel, setTimeout(() => { cur.fileTimers.delete(rel); void this.fileChanged(cur, rel); }, 350));
      });
      cur.watcher.on('error', () => {});
    } catch { cur.watcher = null; }
  }

  /** 저장소 미션: 일꾼마다 자기 작업 폴더에서 바뀐 파일. 작업 폴더에는 일꾼이 한 명뿐이라 누가 썼는지가 정확하다. */
  private async pollWorktrees(cur: Current) {
    const c = cur.conductor;
    if (!c || cur.polling || this.current !== cur) return;
    if (cur.mission.status !== 'working' && cur.polledAt > (cur.mission.endedAt ?? 0)) return;
    cur.polling = true;
    try {
      cur.polledAt = Date.now();
      for (const { who, ref, upstream } of c.workspaces()) {
        if (who === LEAD || ref.kind !== 'branch') continue;
        for (const rel of await changedFiles(ref, upstream)) await this.fileChanged(cur, `${ref.task}/${rel}`, who);
      }
    } finally { cur.polling = false; }
  }

  private async fileChanged(cur: Current, rel: string, by?: string) {
    if (this.current !== cur) return;
    const abs = await this.resolve(cur.mission.id, rel);
    const st = abs ? await stat(abs).catch(() => null) : null;
    if (!abs || !st || !st.isFile()) return;
    const files = cur.mission.files;
    const i = files.findIndex((f) => f.path === rel);
    if (i >= 0 && files[i].size === st.size && files[i].at === st.mtimeMs) return;
    const file: FileInfo = {
      path: rel, name: path.basename(rel), ext: path.extname(rel).slice(1).toLowerCase(), size: st.size, at: st.mtimeMs,
      by: by ?? cur.writers.get(abs) ?? workingAt(cur.spans, st.mtimeMs) ?? (i >= 0 ? files[i].by : 'chef'),
    };
    if (i >= 0) files[i] = file; else files.push(file);
    this.record(cur, { k: 'file', file, isNew: i < 0 });
    this.save();
    if (st.size <= MAX_VERSION_SIZE) void this.keepVersion(cur.mission.id, rel, abs, st.mtimeMs, file.by);
  }

  /** 결과물의 버전마다 사본을 남긴다(버전 기록). */
  private async keepVersion(missionId: string, rel: string, abs: string, at: number, by: string) {
    try {
      const dir = path.join(this.verDir, missionId, versionDirName(rel));
      await mkdir(dir, { recursive: true });
      const safeBy = by.replace(/[^\w-]/g, '').slice(0, 64) || 'chef';
      await copyFile(abs, path.join(dir, `${Math.round(at)}__${safeBy}${path.extname(rel)}`));
      const all = (await readdir(dir)).sort();
      for (const old of all.slice(0, Math.max(0, all.length - MAX_VERSIONS))) await unlink(path.join(dir, old)).catch(() => {});
    } catch { /* 이번에는 버전을 남기지 못했다. 파일은 그대로 있다 */ }
  }

  /** 결과물의 버전 목록, 최신순. */
  async versions(missionId: string, file: string): Promise<VersionInfo[]> {
    await this.inside(missionId, file);
    const dir = path.join(this.verDir, missionId, versionDirName(file));
    const names = await readdir(dir).catch(() => [] as string[]);
    const out: VersionInfo[] = [];
    for (const n of names) {
      const m = n.match(/^(\d+)__([\w-]*)/);
      if (!m) continue;
      const st = await stat(path.join(dir, n)).catch(() => null);
      if (st) out.push({ id: n, at: Number(m[1]), size: st.size, by: m[2] || 'chef' });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  /**
   * 미션 파일의 진짜 경로(링크를 모두 따라간 뒤), 닿을 수 없으면 null. 닿을 수 있는 곳은 정해진 뿌리뿐이다:
   * 미션 폴더, 그리고 지금 미션의 살아 있는 작업 폴더(경로 앞이 할 일 키, 예: code-a/src/app.ts).
   */
  async resolve(missionId: string, rel: string): Promise<string | null> {
    const m = this.mission(missionId);
    if (!m || !rel) return null;
    const cur = this.current;
    if (cur?.mission.id === missionId) {
      const [head, ...rest] = rel.split('/');
      const ws = cur.conductor?.workspaces().find((w) => w.who !== LEAD && w.ref.task === head);
      if (ws && rest.length) return resolveInside([ws.ref.path], rest.join('/'));
    }
    return resolveInside([m.folder], rel);
  }

  /** 사무실에 다녀간 모든 에이전트, 미션별(최신 미션 먼저). */
  async teamHistory(): Promise<TeamEntry[]> {
    const out: TeamEntry[] = [];
    for (const m of this.missions().slice(0, 40)) {
      const raw = await readFile(path.join(this.recDir, `${m.id}.jsonl`), 'utf8').catch(() => '');
      const byId = new Map<string, TeamEntry>();
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        let l: Logged;
        try { l = JSON.parse(line) as Logged; } catch { continue; }
        const ev = l.ev;
        if (ev.k === 'hire') {
          byId.set(ev.id, {
            missionId: m.id, missionTitle: m.title, at: l.at, id: ev.id, name: ev.name, role: ev.role as Role, task: ev.task,
            status: 'working', tools: 0, tokens: 0, ms: 0, report: '',
          });
        } else if (ev.k === 'report') {
          const e = byId.get(ev.who);
          if (e) e.report = ev.text.slice(0, 600);
        } else if (ev.k === 'leave') {
          const e = byId.get(ev.who);
          if (e) Object.assign(e, { status: ev.ok ? 'done' : 'failed', tools: ev.tools, tokens: ev.tokens, ms: ev.ms || l.at - e.at });
        }
      }
      out.push(...[...byId.values()].reverse());
    }
    return out;
  }

  // ── 사무실 명령 ──
  /** who가 없으면 미션 전체를 멈춘다. */
  stop(who?: string) {
    if (!this.current?.conductor) return;
    this.send({ k: 'user_stop', ...(who ? { who } : {}) });
  }

  /** 도구 허락 요청에 답한다. 이미 끝난 요청이면 조용히 넘어간다(두 번 누름, 그사이 거둬들임). */
  answer(requestId: string, allow: boolean) {
    if (!this.current?.conductor) return;
    this.send({ k: 'user_approved', requestId, allow }, true);
  }

  /** 미션을 놓아준다(하루 마감): 일꾼은 떠나고 end가 기록된다. 사무실이 다음 미션을 받을 준비를 한다. */
  async close() {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    for (const t of cur.fileTimers.values()) clearTimeout(t);
    cur.watcher?.close();
    if (cur.poll) clearInterval(cur.poll);
    // close()의 동기 부분이 leave와 end를 내고 프로세스에 끝내라고 보낸다. 그 뒤는 프로세스가 사라지기를 기다릴 뿐이다
    const released = cur.conductor?.close();
    this.broadcast({ t: 'closed', missionId: cur.mission.id });
    this.save();
    await released;
    await cur.writes;
  }

  /** 미션 파일의 경로(닿을 수 없는 곳이면 거부). */
  private async inside(missionId: string, file?: string) {
    const m = this.mission(missionId);
    if (!m) throw new Error('이 미션은 더 이상 없어요.');
    if (!file) return { m, target: m.folder };
    const target = await this.resolve(missionId, file);
    if (!target) throw new Error('이 파일은 미션 폴더 안에 없어요.');
    return { m, target };
  }

  /** 미션 폴더(또는 그 안의 파일)를 기본 앱으로 연다. */
  async open(missionId: string, file?: string) {
    const { target } = await this.inside(missionId, file);
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    execFile(opener, [target], () => {});
  }

  /** 사무실 폴더나 사무실 규칙(기본 텍스트 편집기)을 연다. */
  openRoot(rules: boolean) {
    const target = rules ? path.join(this.dir, RULES_FILE) : this.dir;
    if (rules && !existsSync(target)) writeFileSync(target, RULES_TEMPLATE);
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    execFile(opener, rules && process.platform === 'darwin' ? ['-t', target] : [target], () => {});
  }

  /** 결과물(보고서, CSV…)의 텍스트. 사무실 안에서 읽을 때 쓴다. */
  async readText(missionId: string, file: string, version?: string) {
    let { target } = await this.inside(missionId, file);
    if (version) {
      if (!/^\d+__[\w-]*(\.[\w-]+)?$/.test(version)) throw new Error('알 수 없는 버전이에요.');
      target = path.join(this.verDir, missionId, versionDirName(file), version);
      if (!existsSync(target)) throw new Error('이 버전은 더 이상 없어요.');
    }
    const st = await stat(target);
    const max = 400_000;
    const buf = await readFile(target);
    return { text: buf.subarray(0, max).toString('utf8'), truncated: st.size > max };
  }

  /** 미션 기록. 다시 재생할 때 쓴다(팀을 다시 부르지 않고 촬영할 때 편하다). */
  async replay(missionId: string): Promise<{ mission: MissionInfo; log: Logged[] }> {
    const m = this.mission(missionId);
    if (!m) throw new Error('이 미션은 더 이상 없어요.');
    const raw = await readFile(path.join(this.recDir, `${m.id}.jsonl`), 'utf8').catch(() => '');
    const log: Logged[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { log.push(JSON.parse(line) as Logged); } catch { /* 잘린 줄 */ }
    }
    if (!log.length) throw new Error('이 미션은 기록되지 않았어요.');
    return { mission: m, log };
  }

  /** 묶어서 저장한다(최대 초당 1번). 반쯤 쓰인 파일이 남지 않도록 한 번에 쓴다. */
  save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(async () => {
      this.saveTimer = null;
      try {
        const tmp = this.stateFile + '.tmp';
        await writeFile(tmp, JSON.stringify(this.state));
        await rename(tmp, this.stateFile);
      } catch (e) {
        console.error('  ⚠  사무실을 저장할 수 없어요:', e instanceof Error ? e.message : e);
      }
    }, 1000);
  }

  /** 브리지가 멈춘다: 미션을 놓아주고(프로세스는 바로 끝난다) 저장한다. */
  shutdown() {
    const cur = this.current;
    if (cur) {
      cur.watcher?.close();
      if (cur.poll) clearInterval(cur.poll);
      void cur.conductor?.close();
    }
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    try {
      const tmp = this.stateFile + '.tmp';
      writeFileSync(tmp, JSON.stringify(this.state));
      renameSync(tmp, this.stateFile);
    } catch { /* 어쩔 수 없다. 마지막으로 저장한 상태가 남는다 */ }
  }
}

function trackSpan(spans: Map<string, [number, number][]>, id: string, working: boolean) {
  const list = spans.get(id) ?? [];
  spans.set(id, list);
  const last = list.at(-1);
  const open = last !== undefined && last[1] === Infinity;
  if (working && !open) list.push([Date.now(), Infinity]);
  if (!working && open) last[1] = Date.now();
}

/** 그 시각에 일하던 일꾼이 한 명뿐이면 그 일꾼. */
export function workingAt(spans: Map<string, [number, number][]>, mtimeMs: number): string | undefined {
  // 구간은 Date.now()의 정수 밀리초이고 mtimeMs에는 소수점 아래가 있다. 턴 끝 바로 그 밀리초에 쓴 파일을 놓치지 않게 같은 단위로 비교한다
  const t = Math.floor(mtimeMs);
  const hits = [...spans].filter(([, list]) => list.some(([a, b]) => a <= t && t <= b));
  return hits.length === 1 ? hits[0][0] : undefined;
}
