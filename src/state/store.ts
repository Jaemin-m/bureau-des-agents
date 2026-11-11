// 브라우저 쪽 사무실 기억: 진행 중인 미션, 팀, 계획, 결과물, 맥스가 하는 말.
// 브리지에서 온 이벤트를 여기에 정리한 뒤 게임 엔진(로봇)에 넘긴다.
import { create } from 'zustand';
import { countStats, emptyStats } from '../../shared/activity.ts';
import type {
  ActKind, ClaudeInfo, ClientMsg, FileInfo, MissionInfo, MissionStats, OfficeEvent, PlanItem, Quota, Role, ServerMsg, Settings, TeamEntry, VersionInfo,
} from '../../shared/protocol.ts';
import { sfx } from '../audio/sfx.ts';
import { say } from '../audio/voice.ts';
import { bus } from './bus.ts';

export interface ActView { id: string; kind: ActKind; label: string; detail: string; at: number; ok?: boolean }

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
}

export interface ChefView {
  say: string;
  sayAt: number;
  typing: string;
  thinkingAt: number;
  act: ActView | null;
  acts: ActView[];
}

export interface AskView { requestId: string; who: string; tool: string; label: string; detail: string; full: boolean; at: number }

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
  asks: Record<string, AskView>;
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
      mission: m, chef: emptyChef(), agents: {}, order: [], plan: [], files: [], asks: {}, stats: emptyStats(),
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
          chef: { ...s.chef, say: '', typing: '', thinkingAt: at }, final: null, showFinal: false,
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
        const a: AgentView = {
          id: ev.id, role: ev.role, name: ev.name, task: ev.task, prompt: ev.prompt, status: 'working', act: null, acts: [],
          say: '', sayAt: 0, report: '', hiredAt: at, tokens: 0, tools: 0,
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
        const ask: AskView = { requestId: ev.requestId, who: ev.who, tool: ev.tool, label: ev.label, detail: ev.detail, full: ev.full, at };
        set({ asks: { ...s.asks, [ev.requestId]: ask }, feed: feed(agentName(ev.who), ev.label, 'ask') });
        if (live) { sfx('ask'); void say('feu-vert', true); }
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
    }
    bus.emit(ev, live);
  },
}));

/** 도착한 순서대로 정렬한 팀원. */
export const teamList = (s: S) => s.order.map((id) => s.agents[id]).filter(Boolean);
