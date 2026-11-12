// 서버 쪽 사무실. 진짜 폴더 ~/Documents/에이전트 사무실/ 안에 산다.
//   - “사무실 규칙.md”: 팀이 사용자에 대해 알아야 할 것(맥스가 미션마다 먼저 읽는다).
//   - “미션/”: 미션마다 폴더 하나. 팀이 만든 모든 것을 여기에 둔다.
//   - “.bureau/”(숨김): 사무실 상태와 미션마다의 기록(다시 재생용).
// 미션 하나 = 미션 폴더에서 실행한 Claude Code 세션 하나. 미션이 끝난 뒤에도 다시 말을 걸 수 있고
// (수정 요청), 그러면 같은 세션이 이어진다.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { appendFile, copyFile, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { countStats, emptyStats } from '../shared/activity.ts';
import type { ClaudeInfo, FileInfo, Logged, MissionInfo, OfficeEvent, Quota, Role, ServerMsg, Settings, TeamEntry, VersionInfo } from '../shared/protocol.ts';
import { ClaudeProcess, Normalizer, type ClaudeBinary, type TurnResult } from './claude.ts';
import { openTap, type LoggedFrom, type WireTap } from './record.ts';
import { agentsJson, ALWAYS_ALLOWED, chefPrompt, SESSION_TOOLS } from './team.ts';

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

const DEFAULT_SETTINGS: Settings = { chefModel: 'sonnet', teamModel: 'sonnet', permission: 'auto' };
const CHEF_MODELS = ['', 'sonnet', 'opus', 'haiku', 'fable'];
const TEAM_MODELS = ['sonnet', 'haiku', 'opus', 'fable', 'inherit'];
const IDLE_STOP_MS = 15 * 60 * 1000;
const MAX_LOG = 8000;
const MAX_MISSIONS = 300;
/** 이보다 큰 파일은 버전을 남기지 않는다(동영상, 큰 내보내기 파일) */
const MAX_VERSION_SIZE = 5_000_000;
const MAX_VERSIONS = 30;

/** 파일 버전을 모아 둘 안전한 폴더 이름(한글 파일 이름은 그대로 둔다). */
const versionDirName = (rel: string) => rel.replace(/[\\/]+/g, '__').replace(/[^\w.\-À-ÿ\u3131-\u318E\uAC00-\uD7A3 ]+/g, '_').slice(0, 160);

interface State { missions: MissionInfo[]; settings: Settings }

interface Live {
  proc: ClaudeProcess;
  norm: Normalizer;
  stopping: boolean;
  /** 마지막으로 보낸 메시지(세션 이어가기가 실패하면 다시 보낸다) */
  lastText: string;
  resumed: boolean;
}

interface Current {
  mission: MissionInfo;
  log: Logged[];
  live: Live | null;
  /** 이 미션에서 이미 쓴 이름 */
  names: Set<string>;
  watcher: FSWatcher | null;
  fileTimers: Map<string, NodeJS.Timeout>;
  idleTimer: NodeJS.Timeout | null;
  /** 팀이 언제부터 일하고 있는지(null = 쉬는 중) */
  busySince: number | null;
  stopAsked: boolean;
  lastChefText: string;
  /** 개발용 녹화(BUREAU_RECORD): 지금 프로세스의 파일 한 쌍, 그리고 지금까지 띄운 프로세스 수 */
  tap: WireTap | null;
  spawns: number;
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

  private claude: ClaudeBinary | null;
  private broadcast: (m: ServerMsg) => void;

  constructor(claude: ClaudeBinary | null, broadcast: (m: ServerMsg) => void, dir?: string) {
    this.claude = claude;
    this.broadcast = broadcast;
    this.dir = dir ?? path.join(os.homedir(), 'Documents', '에이전트 사무실');
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
    // “작업 중”으로 남은 미션(실행 중에 사무실이 꺼졌다)은 중단 상태로 바꾼다
    for (const m of this.state.missions) if (m.status === 'working') m.status = 'stopped';
  }

  claudeInfo(): ClaudeInfo {
    return this.claude ? { found: true, version: this.claude.version, path: this.claude.path } : { found: false };
  }

  get settings() { return this.state.settings; }

  setSettings(p: Partial<Settings>) {
    const cur = this.state.settings;
    this.state.settings = {
      chefModel: typeof p.chefModel === 'string' && CHEF_MODELS.includes(p.chefModel) ? p.chefModel : cur.chefModel,
      teamModel: typeof p.teamModel === 'string' && TEAM_MODELS.includes(p.teamModel) ? p.teamModel : cur.teamModel,
      permission: p.permission === 'ask' || p.permission === 'auto' ? p.permission : cur.permission,
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
      t: 'hello', claude: this.claudeInfo(), dir: this.dir, settings: this.settings, quota: this.quota,
      missions: this.missions(), current: c ? { mission: c.mission, log: c.log } : null,
    };
  }

  private mission(id: string) { return this.state.missions.find((m) => m.id === id) ?? null; }

  // ── 새 미션 ──
  async start(prompt: string) {
    const text = prompt.trim();
    if (!text) throw new Error('맥스에게 원하는 걸 말해 주세요.');
    if (!this.claude) throw new Error('이 컴퓨터에 Claude Code가 설치되어 있지 않아요.');
    if (this.current?.mission.status === 'working') throw new Error('팀이 이미 미션을 하고 있어요. 끝날 때까지 기다리거나 멈춰 주세요.');
    if (this.current) this.close();

    const now = new Date();
    const title = titleOf(text);
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}시 ${pad(now.getMinutes())}분`;
    let folder = path.join(this.missionsDir, cleanName(`${stamp} · ${title.replace(/…$/, '')}`).slice(0, 90));
    for (let n = 2; existsSync(folder); n++) folder = path.join(this.missionsDir, cleanName(`${stamp} · ${title.replace(/…$/, '')} ${n}`).slice(0, 90));
    await mkdir(folder, { recursive: true });

    const mission: MissionInfo = {
      id: 'm' + Date.now().toString(36), title, prompt: text, folder, createdAt: Date.now(), workMs: 0,
      status: 'working', stats: emptyStats(), files: [],
    };
    this.state.missions.push(mission);
    if (this.state.missions.length > MAX_MISSIONS) this.state.missions.splice(0, this.state.missions.length - MAX_MISSIONS);
    this.save();
    const cur: Current = {
      mission, log: [], live: null, names: new Set(), watcher: null, fileTimers: new Map(), idleTimer: null,
      busySince: Date.now(), stopAsked: false, lastChefText: '', tap: null, spawns: 0,
    };
    this.current = cur;
    this.watch(cur);
    this.broadcast({ t: 'mission', mission });
    this.say(text);
  }

  /** 맥스에게 말하기: 미션, 그다음 수정 요청. 맥스가 잠들었으면 세션을 이어서 다시 시작한다. */
  say(text: string) {
    const cur = this.current;
    if (!cur) throw new Error('먼저 미션을 시작해 주세요.');
    const clean = text.trim();
    if (!clean) return;
    if (!this.claude) throw new Error('이 컴퓨터에 Claude Code가 설치되어 있지 않아요.');
    let l = cur.live;
    if (!l || !l.proc.alive) l = this.spawn(cur);
    if (cur.idleTimer) { clearTimeout(cur.idleTimer); cur.idleTimer = null; }
    l.lastText = clean;
    cur.stopAsked = false;
    if (cur.mission.status !== 'working') {
      cur.mission.status = 'working';
      cur.mission.endedAt = undefined;
      cur.busySince = Date.now();
      this.broadcast({ t: 'mission', mission: cur.mission });
    }
    this.record(cur, { k: 'start', text: clean });
    l.proc.send(clean);
  }

  private spawn(cur: Current, opts: { fresh?: boolean } = {}): Live {
    if (!this.claude) throw new Error('이 컴퓨터에 Claude Code가 설치되어 있지 않아요.');
    const s = this.settings;
    const resume = opts.fresh ? undefined : cur.mission.sessionId;
    cur.tap = openTap(cur.mission.id, ++cur.spawns);
    // Normalizer는 현재 미션으로 이벤트를 보낸다. “proc”은 바로 다음 줄이 실행되면 정해진다
    const norm: Normalizer = new Normalizer({
      emit: (ev) => { if (cur.live?.proc === proc) this.onEvent(cur, ev); },
      onQuota: (q) => { this.quota = q; this.broadcast({ t: 'quota', quota: q }); },
      onResult: (r) => { if (cur.live?.proc === proc) this.onResult(cur, r); },
      folder: cur.mission.folder,
      names: cur.names,
    });
    const proc: ClaudeProcess = new ClaudeProcess(
      {
        bin: this.claude.path, cwd: cur.mission.folder, permissionMode: s.permission === 'ask' ? 'acceptEdits' : 'auto',
        model: s.chefModel || undefined, resume, tools: SESSION_TOOLS, allowedTools: ALWAYS_ALLOWED,
        agents: agentsJson(s), appendSystemPrompt: chefPrompt(readRules(this.dir)), useApiKey: process.env.BUREAU_USE_API_KEY === '1', tap: cur.tap,
      },
      (m) => {
        if (cur.live?.proc !== proc) return; // 아직 말하고 있는 예전 프로세스
        const refuse = norm.handle(m);
        if (refuse) proc.refuseControl(refuse);
      },
      (code, signal, stderr) => this.onExit(cur, proc, code, signal, stderr),
    );
    const l: Live = { proc, norm, stopping: false, lastText: '', resumed: !!resume };
    cur.live = l;
    proc.start();
    return l;
  }

  private onEvent(cur: Current, ev: OfficeEvent) {
    const m = cur.mission;
    if (ev.k === 'init') {
      const sid = cur.live?.norm.sessionId;
      if (sid) m.sessionId = sid;
      m.model = ev.model;
    }
    if (ev.k === 'say' && ev.who === 'chef') cur.lastChefText = ev.text;
    countStats(m.stats, ev);
    this.record(cur, ev, 'normalizer');
    if (ev.k === 'hire' || ev.k === 'init') this.save();
  }

  private onResult(cur: Current, r: TurnResult) {
    const l = cur.live;
    // 팀원이 아직 일하는 중: 팀원들이 결과를 넘기면 맥스가 다시 이어받는다
    if (l && l.norm.present.size > 0 && r.ok && !cur.stopAsked) return;
    this.finish(cur, r.ok, r.text.trim() || cur.lastChefText, r.ms, cur.stopAsked);
  }

  private finish(cur: Current, ok: boolean, text: string, ms: number, stopped: boolean) {
    const m = cur.mission;
    if (m.status !== 'working') return;
    // 아직 일하던 팀원(미션 중단, 오류)은 자리를 떠난다
    const present = cur.live?.norm.present;
    if (present?.size) {
      for (const id of present) this.record(cur, { k: 'leave', who: id, ok: false, tokens: 0, tools: 0, ms: 0 });
      present.clear();
    }
    const now = Date.now();
    m.status = ok ? 'done' : stopped ? 'stopped' : 'error';
    m.endedAt = now;
    if (cur.busySince) m.workMs += now - cur.busySince;
    cur.busySince = null;
    if (text) m.final = text.slice(0, 20000);
    // 아직 열려 있는 요청은 더 이상 의미가 없다
    const l = cur.live;
    if (l) for (const id of l.norm.pendingRequests()) { l.norm.forgetRequest(id); this.record(cur, { k: 'ask_done', requestId: id, allow: false, cancelled: true }); }
    this.record(cur, { k: 'end', ok, text: m.final ?? '', ms, stopped });
    this.broadcast({ t: 'mission', mission: m });
    this.save();
    // 맥스는 수정 요청을 위해 잠시 대기하다가 잠든다(다시 말을 걸면 세션을 이어간다)
    if (cur.idleTimer) clearTimeout(cur.idleTimer);
    cur.idleTimer = setTimeout(() => {
      if (this.current === cur && cur.mission.status !== 'working' && cur.live) { cur.live.stopping = true; cur.live.proc.stop(); }
    }, IDLE_STOP_MS);
  }

  private onExit(cur: Current, proc: ClaudeProcess, code: number | null, signal: string | null, stderr: string) {
    const l = cur.live;
    if (!l || l.proc !== proc) return;
    cur.live = null;
    const failed = !l.stopping && (code !== 0 || signal !== null);
    // 이어갈 세션이 더 이상 없다(Claude Code는 오래된 세션을 지운다). 처음부터 다시 시작한다.
    if (failed && l.resumed && !l.norm.started && l.lastText && this.current === cur) {
      this.record(cur, { k: 'error', message: '예전 대화를 찾을 수 없어요. 마지막 메시지로 처음부터 다시 시작할게요.' });
      cur.mission.sessionId = undefined;
      const fresh = this.spawn(cur, { fresh: true });
      fresh.lastText = l.lastText;
      fresh.proc.send(l.lastText);
      return;
    }
    if (cur.mission.status === 'working') {
      const message = failed
        ? (stderr.split('\n').filter(Boolean).slice(-3).join(' ') || (signal ? `Claude Code가 멈췄어요(${signal}).` : `Claude Code가 멈췄어요(코드 ${code}).`))
        : 'Claude Code가 멈췄어요.';
      if (!cur.stopAsked) this.record(cur, { k: 'error', message });
      // 아직 남아 있는 팀원은 떠난다
      for (const id of l.norm.present) this.record(cur, { k: 'leave', who: id, ok: false, tokens: 0, tools: 0, ms: 0 });
      l.norm.present.clear();
      cur.live = l; // 열린 요청을 정리하는 동안만
      this.finish(cur, false, cur.lastChefText, 0, cur.stopAsked);
      cur.live = null;
    }
  }

  private record(cur: Current, ev: OfficeEvent, from: LoggedFrom = 'bureau') {
    const at = Date.now();
    this.broadcast({ t: 'ev', missionId: cur.mission.id, at, ev });
    if (ev.k === 'typing') return; // 기록하기엔 너무 잦다
    cur.tap?.logged({ at, ev }, from);
    cur.log.push({ at, ev });
    if (cur.log.length > MAX_LOG) cur.log.splice(0, cur.log.length - MAX_LOG);
    void appendFile(path.join(this.recDir, `${cur.mission.id}.jsonl`), JSON.stringify({ at, ev }) + '\n').catch(() => {});
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

  private async fileChanged(cur: Current, rel: string) {
    if (this.current !== cur) return;
    const abs = path.join(cur.mission.folder, rel);
    const st = await stat(abs).catch(() => null);
    if (!st || !st.isFile()) return;
    const files = cur.mission.files;
    const i = files.findIndex((f) => f.path === rel);
    if (i >= 0 && files[i].size === st.size && files[i].at === st.mtimeMs) return;
    const file: FileInfo = {
      path: rel, name: path.basename(rel), ext: path.extname(rel).slice(1).toLowerCase(), size: st.size, at: st.mtimeMs,
      by: cur.live?.norm.writers.get(abs) ?? (i >= 0 ? files[i].by : 'chef'),
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
    this.inside(missionId, file);
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

  /** 사이트 미리보기용 미션 파일 경로(폴더 밖이면 null). */
  previewPath(missionId: string, rel: string): string | null {
    const m = this.mission(missionId);
    if (!m) return null;
    const target = path.resolve(m.folder, rel);
    if (!target.startsWith(m.folder + path.sep) || !existsSync(target)) return null;
    return target;
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
  stop() {
    const cur = this.current;
    if (!cur || cur.mission.status !== 'working') return;
    cur.stopAsked = true;
    if (cur.live?.proc.alive) cur.live.proc.interrupt();
    else this.finish(cur, false, cur.lastChefText, 0, true);
  }

  answer(requestId: string, allow: boolean) {
    const cur = this.current;
    const l = cur?.live;
    if (!cur || !l || !l.norm.hasRequest(requestId)) return;
    l.proc.answerPermission(requestId, allow, l.norm.inputOf(requestId));
    l.norm.forgetRequest(requestId);
    this.record(cur, { k: 'ask_done', requestId, allow });
  }

  /** 미션을 정리한다(하루 마감). 사무실이 다음 미션을 받을 준비를 한다. */
  close() {
    const cur = this.current;
    if (!cur) return;
    if (cur.mission.status === 'working') { cur.stopAsked = true; this.finish(cur, false, cur.lastChefText, 0, true); }
    if (cur.idleTimer) clearTimeout(cur.idleTimer);
    for (const t of cur.fileTimers.values()) clearTimeout(t);
    cur.watcher?.close();
    if (cur.live) { cur.live.stopping = true; cur.live.proc.stop(); }
    this.current = null;
    this.broadcast({ t: 'closed', missionId: cur.mission.id });
    this.save();
  }

  /** 미션 파일의 경로(폴더 밖이면 거부). */
  private inside(missionId: string, file?: string) {
    const m = this.mission(missionId);
    if (!m) throw new Error('이 미션은 더 이상 없어요.');
    if (!file) return { m, target: m.folder };
    const target = path.resolve(m.folder, file);
    if (!target.startsWith(m.folder + path.sep) || !existsSync(target)) throw new Error('이 파일은 미션 폴더 안에 없어요.');
    return { m, target };
  }

  /** 미션 폴더(또는 그 안의 파일)를 기본 앱으로 연다. */
  open(missionId: string, file?: string) {
    const { target } = this.inside(missionId, file);
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
    let { target } = this.inside(missionId, file);
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

  /** 브리지가 멈춘다: 모두 즉시 멈추고 저장한다. */
  shutdown() {
    const cur = this.current;
    if (cur) {
      if (cur.mission.status === 'working') { cur.mission.status = 'stopped'; cur.mission.endedAt = Date.now(); if (cur.busySince) cur.mission.workMs += Date.now() - cur.busySince; }
      cur.watcher?.close();
      if (cur.live) { cur.live.stopping = true; cur.live.proc.kill(); }
    }
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    try {
      const tmp = this.stateFile + '.tmp';
      writeFileSync(tmp, JSON.stringify(this.state));
      renameSync(tmp, this.stateFile);
    } catch { /* 어쩔 수 없다. 마지막으로 저장한 상태가 남는다 */ }
  }
}
