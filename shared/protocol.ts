// 사무실(브라우저)과 브리지(Claude Code를 조종하는 Node 서버) 사이의 약속.
// 모든 것이 WebSocket 연결 하나로 JSON으로 오간다. “지울 수 있는(erasable)” 문법만 쓴다.
// 이 파일은 Node(컴파일 없이)와 Vite가 그대로 읽는다.

/** 사무실의 직무. “chef” = 메인 에이전트, 사용자가 말을 거는 상대. */
export type Role = 'chef' | 'recherche' | 'code' | 'design' | 'redaction' | 'analyse' | 'renfort';

/** 에이전트가 지금 하는 일. 애니메이션, 아이콘, 말풍선에 쓴다. */
export type ActKind = 'search' | 'web' | 'read' | 'write' | 'edit' | 'bash' | 'plan' | 'skill' | 'mcp' | 'other';

export interface PlanItem { text: string; status: 'pending' | 'in_progress' | 'completed' }

/** 팀이 미션 폴더에 만든 파일. */
export interface FileInfo { path: string; name: string; ext: string; size: number; at: number; by: string }

export interface MissionStats { agents: number; searches: number; pages: number; reads: number; writes: number; commands: number }

export type MissionStatus = 'working' | 'done' | 'stopped' | 'error';

export interface MissionInfo {
  id: string;
  title: string;
  prompt: string;
  /** 사용자 컴퓨터에 있는 미션 폴더 */
  folder: string;
  createdAt: number;
  endedAt?: number;
  /** 누적 작업 시간(이어서 한 작업까지 모두 포함) */
  workMs: number;
  status: MissionStatus;
  sessionId?: string;
  model?: string;
  stats: MissionStats;
  files: FileInfo[];
  /** 미션을 마친 뒤 팀장의 마지막 메시지 */
  final?: string;
}

/**
 * 사무실에서 일어나는 일. `who`는 “chef” 또는 팀원 에이전트의 식별자다
 * (그 팀원을 부른 Agent 호출의 식별자).
 */
export type OfficeEvent =
  | { k: 'start'; text: string }
  | { k: 'init'; model: string; auth: string }
  | { k: 'think'; who: string }
  | { k: 'typing'; who: string; text: string }
  | { k: 'say'; who: string; text: string }
  | { k: 'plan'; items: PlanItem[] }
  | { k: 'hire'; id: string; role: Role; type: string; name: string; task: string; prompt: string }
  | { k: 'act'; who: string; id: string; kind: ActKind; tool: string; label: string; detail: string }
  | { k: 'act_done'; who: string; id: string; ok: boolean }
  /** 에이전트가 팀장에게 제출하는 보고서 */
  | { k: 'report'; who: string; text: string }
  /** 에이전트가 일을 마치고 자리를 떠남 */
  | { k: 'leave'; who: string; ok: boolean; tokens: number; tools: number; ms: number }
  | { k: 'file'; file: FileInfo; isNew: boolean }
  /** full = 말풍선이 행동 전체를 보여 줌(아니면 모든 내용이 나오는 패널에서 답한다) */
  | { k: 'ask'; who: string; requestId: string; tool: string; label: string; detail: string; full: boolean }
  | { k: 'ask_done'; requestId: string; allow: boolean; cancelled?: boolean }
  | { k: 'end'; ok: boolean; text: string; ms: number; stopped?: boolean }
  | { k: 'error'; message: string };

/** 기록되는 그대로의, 시각이 붙은 이벤트. */
export interface Logged { at: number; ev: OfficeEvent }

export interface ClaudeInfo { found: boolean; version?: string; path?: string }

/** 결과물 파일의 저장된 버전(팀이 고칠 때마다 생긴다). */
export interface VersionInfo { id: string; at: number; size: number; by: string }

/** 에이전트가 사무실에 다녀간 기록(팀 기록용). */
export interface TeamEntry {
  missionId: string;
  missionTitle: string;
  at: number;
  id: string;
  name: string;
  role: Role;
  task: string;
  status: 'working' | 'done' | 'failed';
  tools: number;
  tokens: number;
  ms: number;
  report: string;
}

export interface Settings {
  /** 팀장의 두뇌: '' = Claude Code 기본 모델 */
  chefModel: string;
  /** 팀의 두뇌: sonnet, haiku, opus, fable 또는 inherit(팀장과 같은 모델) */
  teamModel: string;
  /** auto: 팀이 스스로 정하고 위험한 작업만 묻는다. ask: 명령마다 먼저 묻는다 */
  permission: 'auto' | 'ask';
}

export interface Quota { fiveHour: number; resetsAt: number | null }

// ── 브라우저 → 서버 ──
export type ClientMsg =
  | { t: 'start'; prompt: string }
  | { t: 'say'; text: string }
  | { t: 'stop' }
  | { t: 'answer'; requestId: string; allow: boolean }
  | { t: 'new' }
  | { t: 'open'; missionId: string; file?: string }
  /** 사무실 폴더(또는 사무실 규칙)를 연다 */
  | { t: 'open_root'; rules?: boolean }
  | { t: 'read'; missionId: string; file: string; version?: string }
  | { t: 'versions'; missionId: string; file: string }
  | { t: 'team_history' }
  | { t: 'replay'; missionId: string }
  | { t: 'settings'; settings: Partial<Settings> };

// ── 서버 → 브라우저 ──
export type ServerMsg =
  | { t: 'hello'; claude: ClaudeInfo; dir: string; settings: Settings; quota: Quota | null; missions: MissionInfo[]; current: { mission: MissionInfo; log: Logged[] } | null; build?: string }
  | { t: 'mission'; mission: MissionInfo }
  | { t: 'ev'; missionId: string; at: number; ev: OfficeEvent }
  | { t: 'closed'; missionId: string }
  | { t: 'replay'; mission: MissionInfo; log: Logged[] }
  | { t: 'file_text'; missionId: string; file: string; text: string; truncated: boolean; version?: string }
  | { t: 'versions'; missionId: string; file: string; list: VersionInfo[] }
  | { t: 'team_history'; entries: TeamEntry[] }
  | { t: 'quota'; quota: Quota }
  | { t: 'settings'; settings: Settings }
  | { t: 'toast'; kind: 'info' | 'error'; text: string };
