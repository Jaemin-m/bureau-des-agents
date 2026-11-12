// 브라우저 쪽 사무실 기억: 진행 중인 미션, 팀, 계획, 결과물, 맥스가 하는 말.
// 브리지에서 온 이벤트를 여기에 정리한 뒤 게임 엔진(로봇)에 넘긴다.
import { create } from 'zustand';
import { countStats, emptyStats } from '../../shared/activity.ts';
import type {
  ActKind, AgentKind, BlockReason, ClaudeInfo, ClientMsg, FileInfo, MissionInfo, MissionStats, MsgKind, OfficeEvent, PlanItem, Quota, Role, ServerMsg,
  Settings, TaskNode, TeamEntry, VersionInfo, WorkerPhase,
} from '../../shared/protocol.ts';
import { sfx } from '../audio/sfx.ts';
import { say } from '../audio/voice.ts';
import { bus } from './bus.ts';

export interface ActView { id: string; kind: ActKind; label: string; detail: string; at: number; ok?: boolean }

export interface ThreadMsg { id: string; from: string; to: string; kind: MsgKind; text: string; replyTo?: string; at: number }

// agent, phase, thread는 새 이벤트가 올 때만 채운다: 옛 기록을 접은 결과가 예전과 한 글자도 다르지 않아야 한다.
// 읽을 때는 agentKindOf, phaseOf를 쓴다.
export interface AgentView {
  id: string;
  role: Role;
  name: string;
  task: string;
  prompt: string;
  status: 'working' | 'reporting' | 'done' | 'failed';
  act: ActView | null;
  acts: ActView[];
  say: string;
  sayAt: number;
  report: string;
  hiredAt: number;
  leftAt?: number;
  tokens: number;
  tools: number;
  agent?: AgentKind;
  phase?: WorkerPhase;
  block?: BlockReason;
  parked?: boolean;
  note?: string;
  thread?: ThreadMsg[];
}

export interface ChefView {
  say: string;
  sayAt: number;
  typing: string;
  thinkingAt: number;
  act: ActView | null;
  acts: ActView[];
}

export interface AskView {
  requestId: string; who: string; tool: string; label: string; detail: string; full: boolean; at: number;
  kind: 'approval' | 'question'; options?: string[];
}

export interface FeedLine { id: number; at: number; who: string; text: string; kind: 'user' | 'chef' | 'hire' | 'act' | 'report' | 'file' | 'ask' | 'end' | 'error' }

export interface Toast { id: number; kind: 'info' | 'error'; text: string }

export type Tod = 'auto' | 'day' | 'evening' | 'night';

/** 사무실을 클릭하면 열리는 창(로봇, 칠판, 시계…). */
export type Modal =
  | { kind: 'agent'; id: string }
  | { kind: 'board' }
  | { kind: 'clock' }
  | { kind: 'machine' }
  | { kind: 'jukebox' }
  | { kind: 'team'; role?: Role }
  | { kind: 'files' }
  | { kind: 'preview'; missionId: string; file: string };

interface S {
  connection: 'connecting' | 'live' | 'offline' | 'demo';
  claude: ClaudeInfo | null;
  dir: string;
  settings: Settings;
  quota: Quota | null;
  missions: MissionInfo[];
  mission: MissionInfo | null;
  /** 다시 보기(또는 데모) 중이면 true */
  replaying: boolean;
  chef: ChefView;
  agents: Record<string, AgentView>;
  order: string[];
  plan: PlanItem[];
  files: FileInfo[];
  /** 열린 요청, 온 순서대로. 키 = requestId */
  asks: Record<string, AskView>;
  tasks: Record<string, TaskNode>;
  /** 모든 일이 끝나 쉬는 중(settle). 미션을 놓아주는 end와는 다르다 */
  settled: { text: string; at: number } | null;
  stats: MissionStats;
  feed: FeedLine[];
  final: { ok: boolean; text: string; ms: number; stopped?: boolean; at: number } | null;
  /** 팀이 일을 시작한 시각(타이머용). null = 쉬는 중 */
  busySince: number | null;
  workMs: number;
  // 인터페이스
  showFinal: boolean;
  viewer: { missionId: string; file: string; text?: string; truncated?: boolean; version?: string } | null;
  modal: Modal | null;
  /** 결과물마다의 버전(키: 미션|파일) */
  versions: Record<string, VersionInfo[]>;
  teamHistory: TeamEntry[] | null;
  /** 계획의 모든 버전, 순서대로(칠판이 기록을 남긴다) */
  planHistory: { at: number; items: PlanItem[] }[];
  music: { playing: boolean; index: number; volume: number };
  /** 맥스의 목소리(브라우저 음성 합성) */
  voiceOn: boolean;
  /** 촬영 모드에서는 카메라가 알아서 행동을 따라간다 */
  cameraAuto: boolean;
  /** 진행 중인 사무실 둘러보기(맥스가 하는 말) */
  tour: { step: number; text: string } | null;
  historyOpen: boolean;
  settingsOpen: boolean;
  vertical: boolean;
  /** 세로로 긴 화면(휴대폰): 세로 프레임과 같은 배치 */
  portrait: boolean;
  filming: boolean;
  sound: boolean;
  tod: Tod;
  draft: string;
  toasts: Toast[];
  send: (m: ClientMsg) => void;
  receive: (m: ServerMsg) => void;
  apply: (ev: OfficeEvent, at: number, live: boolean) => void;
  resetMission: (m: MissionInfo | null) => void;
  toast: (kind: Toast['kind'], text: string) => void;
}

const pref = <T,>(key: string, fallback: T): T => {
  try { const v = localStorage.getItem('bureau:' + key); return v === null ? fallback : (JSON.parse(v) as T); } catch { return fallback; }
};
export const savePref = (key: string, v: unknown) => { try { localStorage.setItem('bureau:' + key, JSON.stringify(v)); } catch { /* 시크릿 모드 */ } };

const emptyChef = (): ChefView => ({ say: '', sayAt: 0, typing: '', thinkingAt: 0, act: null, acts: [] });

let feedId = 0;
let toastId = 0;
let lastActSound = 0;
const MAX_ACTS = 80;
const MAX_FEED = 160;
const MAX_THREAD = 50;

/** worker 이벤트의 단계를 예전 화면이 읽는 status로 옮긴다. */
const PHASE_STATUS: Record<WorkerPhase, AgentView['status']> = {
  provisioning: 'working', starting: 'working', working: 'working', blocked: 'working', stopping: 'working',
  idle: 'done', stopped: 'done', retired: 'done', failed: 'failed',
};
const LEGACY_PHASE: Record<AgentView['status'], WorkerPhase> = { working: 'working', reporting: 'working', done: 'retired', failed: 'failed' };

export const useOffice = create<S>((set, get) => ({
  connection: 'connecting',
  claude: null,
  dir: '',
  settings: { chefModel: 'sonnet', teamModel: 'sonnet', permission: 'auto' },
  quota: null,
  missions: [],
  mission: null,
  replaying: false,
  chef: emptyChef(),
  agents: {},
  order: [],
  plan: [],
  files: [],
  asks: {},
  tasks: {},
  settled: null,
  stats: emptyStats(),
  feed: [],
  final: null,
  busySince: null,
  workMs: 0,
  showFinal: false,
  viewer: null,
  modal: null,
  versions: {},
  teamHistory: null,
  planHistory: [],
  music: { playing: false, index: 0, volume: 0.55 },
  voiceOn: pref('voice', true),
  cameraAuto: pref('cameraAuto', true),
  tour: null,
  historyOpen: false,
  settingsOpen: false,
  vertical: pref('vertical', false),
  portrait: typeof window !== 'undefined' && window.innerWidth / Math.max(1, window.innerHeight) < 0.8,
  filming: false,
  sound: pref('sound', true),
  tod: pref<Tod>('tod', 'auto'),
  draft: '',
  toasts: [],
  send: () => {},

  toast: (kind, text) => {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }].slice(-4) }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 7000 : 4500);
  },

  resetMission: (m) => {
    set({
      mission: m, chef: emptyChef(), agents: {}, order: [], plan: [], files: [], asks: {}, tasks: {}, settled: null, stats: emptyStats(),
      feed: [], final: null, busySince: null, workMs: 0, showFinal: false, planHistory: [],
    });
    bus.reset();
  },

  receive: (m) => {
    const s = get();
    switch (m.t) {
      case 'hello': {
        set({ claude: m.claude, dir: m.dir, settings: m.settings, quota: m.quota, missions: m.missions });
        if (s.replaying) break;
        if (m.current) {
          get().resetMission(m.current.mission);
          for (const l of m.current.log) get().apply(l.ev, l.at, false);
          set({ mission: m.current.mission });
        } else get().resetMission(null);
        break;
      }
      case 'mission': {
        const list = [m.mission, ...s.missions.filter((x) => x.id !== m.mission.id)].sort((a, b) => b.createdAt - a.createdAt);
        set({ missions: list });
        if (s.replaying) break;
        if (s.mission?.id === m.mission.id) set({ mission: m.mission });
        else if (m.mission.status === 'working' && (!s.mission || s.mission.id !== m.mission.id)) get().resetMission(m.mission);
        break;
      }
      case 'ev':
        if (s.replaying || s.mission?.id !== m.missionId) break;
        get().apply(m.ev, m.at, true);
        break;
      case 'closed':
        if (!s.replaying && s.mission?.id === m.missionId) get().resetMission(null);
        break;
      case 'file_text':
        if (s.viewer && s.viewer.file === m.file) set({ viewer: { ...s.viewer, text: m.text, truncated: m.truncated, version: m.version } });
        break;
      case 'versions':
        set({ versions: { ...s.versions, [`${m.missionId}|${m.file}`]: m.list } });
        break;
      case 'team_history':
        set({ teamHistory: m.entries });
        break;
      case 'quota':
        set({ quota: m.quota });
        break;
      case 'settings':
        set({ settings: m.settings });
        break;
      case 'toast':
        get().toast(m.kind, m.text);
        break;
      case 'replay':
        // 재생기(net/replay.ts)가 처리한다
        break;
    }
  },

  apply: (ev, at, live) => {
    const s = get();
    const feed = (who: string, text: string, kind: FeedLine['kind']) => {
      const line: FeedLine = { id: ++feedId, at, who, text, kind };
      return [...get().feed, line].slice(-MAX_FEED);
    };
    const agentName = (who: string) => (who === 'chef' ? '맥스' : s.agents[who]?.name ?? '에이전트');
    switch (ev.k) {
      case 'start': {
        const first = s.feed.length === 0;
        set({
          chef: { ...s.chef, say: '', typing: '', thinkingAt: at }, final: null, showFinal: false, settled: null,
          busySince: at, feed: feed('나', ev.text, 'user'),
        });
        if (live && !first) sfx('send');
        if (live) void say('parti');
        break;
      }
      case 'init':
        break;
      case 'think':
        if (ev.who === 'chef') set({ chef: { ...s.chef, thinkingAt: at } });
        break;
      case 'typing':
        if (ev.who === 'chef') set({ chef: { ...s.chef, typing: ev.text } });
        else if (s.agents[ev.who]) set({ agents: { ...s.agents, [ev.who]: { ...s.agents[ev.who], say: ev.text, sayAt: at } } });
        break;
      case 'say':
        if (ev.who === 'chef') set({ chef: { ...s.chef, say: ev.text, sayAt: at, typing: '' }, feed: feed('맥스', ev.text, 'chef') });
        else if (s.agents[ev.who]) set({ agents: { ...s.agents, [ev.who]: { ...s.agents[ev.who], say: ev.text, sayAt: at } } });
        break;
      case 'plan':
        set({ plan: ev.items, planHistory: [...s.planHistory, { at, items: ev.items }].slice(-60) });
        if (live && s.plan.length !== ev.items.length) sfx('plan');
        else if (live && ev.items.filter((i) => i.status === 'completed').length > s.plan.filter((i) => i.status === 'completed').length) sfx('check');
        break;
      case 'hire': {
        const prev = s.agents[ev.id];
        if (prev) {
          // 같은 일꾼이 다시 온다(재시작 뒤 다시 알림): 한 명으로 두고 단계도 그대로 둔다. 떠났다 돌아오면 다시 일한다
          const back = prev.leftAt !== undefined;
          const a: AgentView = {
            ...prev, role: ev.role, name: ev.name, task: ev.task, prompt: ev.prompt, agent: ev.agent ?? prev.agent,
            ...(back ? { status: 'working', leftAt: undefined, phase: undefined, block: undefined, parked: undefined, note: undefined } : {}),
          };
          set({ agents: { ...s.agents, [ev.id]: a }, ...(back ? { feed: feed('맥스', `${ev.name} 호출: ${ev.task}`, 'hire') } : {}) });
          if (live && back) sfx('spawn');
          break;
        }
        const a: AgentView = {
          id: ev.id, role: ev.role, name: ev.name, task: ev.task, prompt: ev.prompt, status: 'working', act: null, acts: [],
          say: '', sayAt: 0, report: '', hiredAt: at, tokens: 0, tools: 0, agent: ev.agent,
        };
        const stats = { ...s.stats };
        countStats(stats, ev);
        const firstOfRound = !s.order.some((id) => s.agents[id]?.status === 'working' || s.agents[id]?.status === 'reporting');
        set({ agents: { ...s.agents, [ev.id]: a }, order: [...s.order, ev.id], stats, feed: feed('맥스', `${ev.name} 호출: ${ev.task}`, 'hire') });
        if (live) sfx('spawn');
        if (live && firstOfRound) void say('equipe');
        break;
      }
      case 'act': {
        const act: ActView = { id: ev.id, kind: ev.kind, label: ev.label, detail: ev.detail, at };
        const stats = { ...s.stats };
        countStats(stats, ev);
        if (ev.who === 'chef') set({ chef: { ...s.chef, act, acts: [...s.chef.acts, act].slice(-MAX_ACTS) }, stats });
        else if (s.agents[ev.who]) {
          const a = s.agents[ev.who];
          set({ agents: { ...s.agents, [ev.who]: { ...a, act, acts: [...a.acts, act].slice(-MAX_ACTS) } }, stats });
        } else set({ stats });
        if (ev.kind !== 'plan') set({ feed: feed(agentName(ev.who), ev.label, 'act') });
        if (live && Date.now() - lastActSound > 220) { lastActSound = Date.now(); sfx(ev.kind === 'search' || ev.kind === 'web' ? 'search' : 'tick'); }
        break;
      }
      case 'act_done': {
        const mark = (acts: ActView[]) => acts.map((x) => (x.id === ev.id ? { ...x, ok: ev.ok } : x));
        if (ev.who === 'chef') set({ chef: { ...s.chef, acts: mark(s.chef.acts) } });
        else if (s.agents[ev.who]) set({ agents: { ...s.agents, [ev.who]: { ...s.agents[ev.who], acts: mark(s.agents[ev.who].acts) } } });
        break;
      }
      case 'report': {
        const a = s.agents[ev.who];
        if (!a) break;
        set({ agents: { ...s.agents, [ev.who]: { ...a, report: ev.text, status: 'reporting' } }, feed: feed(a.name, '맥스에게 보고서 제출', 'report') });
        if (live) sfx('paper');
        break;
      }
      case 'leave': {
        const a = s.agents[ev.who];
        if (!a) break;
        set({ agents: { ...s.agents, [ev.who]: { ...a, status: ev.ok ? 'done' : 'failed', leftAt: at, tokens: ev.tokens, tools: ev.tools } } });
        break;
      }
      case 'file': {
        const files = [...s.files.filter((f) => f.path !== ev.file.path), ev.file].sort((a, b) => a.at - b.at);
        set({ files, feed: ev.isNew ? feed(agentName(ev.file.by), `${ev.file.name} 저장`, 'file') : get().feed });
        if (live && ev.isNew) sfx('print');
        break;
      }
      case 'ask': {
        const kind = ev.kind ?? 'approval';
        const ask: AskView = { requestId: ev.requestId, who: ev.who, tool: ev.tool, label: ev.label, detail: ev.detail, full: ev.full, at, kind, options: ev.options };
        set({ asks: { ...s.asks, [ev.requestId]: ask }, feed: feed(agentName(ev.who), ev.label, 'ask') });
        if (live) { sfx('ask'); if (kind === 'approval') void say('feu-vert', true); }
        break;
      }
      case 'ask_done': {
        const asks = { ...s.asks };
        delete asks[ev.requestId];
        set({ asks });
        break;
      }
      case 'end': {
        const workMs = s.workMs + (s.busySince ? Math.max(0, at - s.busySince) : 0);
        set({
          final: { ok: ev.ok, text: ev.text, ms: ev.ms, stopped: ev.stopped, at }, busySince: null, workMs, asks: {},
          showFinal: false, feed: feed('맥스', ev.ok ? '미션 완료!' : ev.stopped ? '미션을 멈췄어요.' : '미션이 제대로 끝나지 않았어요.', 'end'),
        });
        if (live) sfx(ev.ok ? 'done' : 'error');
        if (live && ev.ok) setTimeout(() => { void say('accomplie', true); }, 900);
        // 먼저 맥스가 축하하고(색종이), 그다음 결과물 카드가 열린다
        if (live && ev.ok) setTimeout(() => { if (get().final?.at === at) set({ showFinal: true }); }, 3200);
        break;
      }
      case 'error':
        set({ feed: feed('맥스', ev.message, 'error') });
        if (live) get().toast('error', ev.message);
        break;
      case 'worker': {
        const a = s.agents[ev.id];
        if (!a) break;
        set({
          agents: { ...s.agents, [ev.id]: { ...a, phase: ev.phase, block: ev.block, parked: ev.parked, note: ev.note, status: PHASE_STATUS[ev.phase] } },
          // 쉬던 미션에 일꾼이 다시 일하기 시작하면(이어서 시킨 일) 타이머도 다시 돈다
          ...(ev.phase === 'working' && s.settled ? { settled: null, busySince: s.busySince ?? at } : {}),
        });
        break;
      }
      case 'task':
        set({ tasks: { ...s.tasks, [ev.key]: { key: ev.key, title: ev.title, after: ev.after, role: ev.role, agent: ev.agent, run: ev.run } } });
        break;
      case 'msg': {
        const m: ThreadMsg = { id: ev.id, from: ev.from, to: ev.to, kind: ev.kind, text: ev.text, replyTo: ev.replyTo, at };
        const agents = { ...s.agents };
        let added = false;
        for (const id of new Set([ev.from, ev.to])) {
          const a = agents[id];
          if (!a || a.thread?.some((x) => x.id === ev.id)) continue;
          agents[id] = { ...a, thread: [...(a.thread ?? []), m].slice(-MAX_THREAD) };
          added = true;
        }
        if (!added) break;
        const fromUser = ev.from === 'user';
        set({ agents, ...(fromUser ? { feed: feed('나', `${agentName(ev.to)}에게: ${ev.text}`, 'user') } : {}) });
        if (live && fromUser) sfx('send');
        break;
      }
      case 'settle': {
        if (s.settled) { set({ settled: { ...s.settled, text: ev.text } }); break; }
        const workMs = s.workMs + (s.busySince ? Math.max(0, at - s.busySince) : 0);
        set({ settled: { text: ev.text, at }, busySince: null, workMs, feed: feed('맥스', '모두 일을 마쳤어요.', 'end') });
        if (live) sfx('done');
        break;
      }
    }
    bus.emit(ev, live);
  },
}));

/** 도착한 순서대로 정렬한 팀원. */
export const teamList = (s: S) => s.order.map((id) => s.agents[id]).filter(Boolean);

/** 일꾼을 돌리는 CLI. 옛 기록의 팀원은 모두 claude. */
export const agentKindOf = (a: AgentView): AgentKind => a.agent ?? 'claude';

/** 일꾼의 단계. worker 이벤트가 없던 옛 기록은 status에서 읽는다. */
export const phaseOf = (a: AgentView): WorkerPhase => a.phase ?? LEGACY_PHASE[a.status];
