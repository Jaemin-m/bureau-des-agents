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

/** 일꾼을 실제로 돌리는 CLI. 이 목록 하나에서 타입이 나온다. 직무(Role)와는 따로다: 직무는 책상·모습·이름, CLI는 배지. */
export const AGENT_KINDS = ['claude', 'codex', 'gemini'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** 일꾼의 단계(화면용). 같은 단계를 두 번 받아도 결과는 같다. */
export type WorkerPhase = 'provisioning' | 'starting' | 'working' | 'blocked' | 'idle' | 'stopping' | 'stopped' | 'failed' | 'retired';
export type BlockReason = 'approval' | 'question';

export interface TaskResult {
  /** 일꾼이 직접 쓴 요약(최대 4000자). 전문은 report와 msg 이벤트에 있다 */
  summary: string;
  /** 저장소 미션만. 전체 경로는 절대 싣지 않는다: 브랜치 이름과 숫자만 */
  branch?: string;
  base?: string;
  head?: string;
  files?: number;
  ins?: number;
  del?: number;
  mergeable?: 'clean' | 'conflict' | 'unknown';
  merged?: boolean;
  /** 사용자가 버렸다: 브랜치는 지우지 않고 보관 ref(refs/bureau/archive/…)로 옮겼다 */
  archived?: boolean;
  /** 이 브랜치에서 일한 일꾼의 id */
  by?: string;
}

/**
 * 할 일이 저장하는 유일한 상태: 실행 기록. 대기·준비·막힘은 저장하지 않고
 * shared/tasks.ts의 taskStatus가 의존 관계에서 계산한다.
 */
export type TaskRun =
  | { k: 'pending' }
  | { k: 'running'; worker: string }
  | { k: 'done'; result: TaskResult }
  | { k: 'failed'; why: string; attempts: number }
  | { k: 'cancelled' };

/** 할 일 그래프의 한 칸. `after` = 먼저 끝나야 하는 할 일의 키. */
export interface TaskNode { key: string; title: string; after: string[]; role?: Role; agent?: AgentKind; run: TaskRun }

/** 대화 한 줄의 종류. brief = 첫 지시, followup = 끝난 뒤 이어서 시키는 말, answer = 질문에 대한 답. */
export type MsgKind = 'brief' | 'followup' | 'answer' | 'question' | 'note' | 'news';

/** 미션이 일하는 곳. `label`은 화면에 보이는 이름이고, 저장소의 전체 경로는 서버에만 있다. */
export type MissionTarget = { kind: 'folder' } | { kind: 'repo'; label: string; baseBranch: string };

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
  /** 없으면 미션 폴더(옛 미션 모두) */
  target?: MissionTarget;
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
  /** 같은 id로 다시 와도 팀원은 한 명이다. agent가 없으면(옛 기록) claude. 맡은 일은 task.run에서 나온다 */
  | { k: 'hire'; id: string; role: Role; type: string; name: string; task: string; prompt: string; agent?: AgentKind }
  | { k: 'act'; who: string; id: string; kind: ActKind; tool: string; label: string; detail: string }
  | { k: 'act_done'; who: string; id: string; ok: boolean }
  /** 에이전트가 팀장에게 제출하는 보고서 */
  | { k: 'report'; who: string; text: string }
  /** 에이전트가 일을 마치고 자리를 떠남 */
  | { k: 'leave'; who: string; ok: boolean; tokens: number; tools: number; ms: number }
  | { k: 'file'; file: FileInfo; isNew: boolean }
  /**
   * full = 말풍선이 행동 전체를 보여 줌(아니면 모든 내용이 나오는 패널에서 답한다).
   * kind: 'approval'(없으면 이것) = 도구 허락, {t:'answer'}로 답한다. 'question' = 일꾼의 질문, {t:'reply'}로 답한다
   */
  | { k: 'ask'; who: string; requestId: string; tool: string; label: string; detail: string; full: boolean; kind?: 'approval' | 'question'; options?: string[] }
  | { k: 'ask_done'; requestId: string; allow: boolean; cancelled?: boolean }
  | { k: 'end'; ok: boolean; text: string; ms: number; stopped?: boolean }
  | { k: 'error'; message: string }
  /** 일꾼의 단계가 바뀜. 지금 맡은 할 일은 싣지 않는다: run이 이 일꾼을 가리키는 할 일이 그것이다 */
  | { k: 'worker'; id: string; phase: WorkerPhase; block?: BlockReason; parked?: boolean; note?: string }
  /** 할 일 한 칸을 통째로 다시 보낸다: 두 번 접어도 한 번 접은 것과 같다 */
  | ({ k: 'task' } & TaskNode)
  /** 대화 한 줄: 사용자↔일꾼, 일꾼→맥스, 맥스→일꾼. 사용자가 일꾼에게 하는 말은 start가 아니라 이것이다 */
  | { k: 'msg'; id: string; from: string; to: string; kind: MsgKind; text: string; replyTo?: string }
  /** 모든 일이 끝나 미션이 쉬는 중(일꾼은 자리에 남는다). end는 미션을 놓아줄 때만 온다 */
  | { k: 'settle'; text: string };

/** 기록되는 그대로의, 시각이 붙은 이벤트. */
export interface Logged { at: number; ev: OfficeEvent }

export interface ClaudeInfo { found: boolean; version?: string; path?: string }

/** 이 컴퓨터에 깔린 CLI 하나. */
export interface AgentInfo { kind: AgentKind; found: boolean; version?: string }

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
  /** codex 일꾼의 모델(codex의 이름). 없거나 ''이면 codex의 기본값 */
  codexModel?: string;
}

export interface Quota { fiveHour: number; resetsAt: number | null }

// ── 브라우저 → 서버 ──
export type ClientMsg =
  /** target이 없으면 지금처럼 미션 폴더에서 일한다 */
  | { t: 'start'; prompt: string; target?: { repo: string } }
  /** to = 일꾼 id. 없으면 맥스에게(지금처럼) */
  | { t: 'say'; text: string; to?: string }
  /** who = 그 일꾼만 멈춘다. 없으면 미션 전체(지금처럼) */
  | { t: 'stop'; who?: string }
  /** 일꾼의 질문(ask kind:'question')에 답한다 */
  | { t: 'reply'; requestId: string; text: string }
  | { t: 'resume' }
  /** 저장소 경로를 확인한다. 답(repo_info)은 기록되지 않는다 */
  | { t: 'repo_check'; path: string }
  | { t: 'merge'; taskKey: string }
  /** 지금 합칠 수 있는지 묻는다. 답(merge_info)은 기록되지 않는다 */
  | { t: 'merge_check'; taskKey: string }
  /** 브랜치를 지우지 않고 보관 ref로 옮긴다 */
  | { t: 'discard_branch'; taskKey: string }
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
  /** agents = 깔린 CLI 목록(claude는 옛 탭을 위해 남긴다) */
  | { t: 'hello'; claude: ClaudeInfo; agents?: AgentInfo[]; dir: string; settings: Settings; quota: Quota | null; missions: MissionInfo[]; current: { mission: MissionInfo; log: Logged[] } | null; build?: string }
  | { t: 'mission'; mission: MissionInfo }
  | { t: 'ev'; missionId: string; at: number; ev: OfficeEvent }
  | { t: 'closed'; missionId: string }
  | { t: 'replay'; mission: MissionInfo; log: Logged[] }
  | { t: 'file_text'; missionId: string; file: string; text: string; truncated: boolean; version?: string }
  | { t: 'versions'; missionId: string; file: string; list: VersionInfo[] }
  | { t: 'team_history'; entries: TeamEntry[] }
  | { t: 'quota'; quota: Quota }
  | { t: 'settings'; settings: Settings }
  | { t: 'toast'; kind: 'info' | 'error'; text: string }
  /** repo_check의 답. 미션 상태를 바꾸지 않고 기록되지도 않는다 */
  | { t: 'repo_info'; path: string; ok: boolean; label?: string; branch?: string; dirty?: boolean; why?: string }
  /** merge_check의 답: 사용자의 체크아웃이 기준 브랜치에 있고, 깨끗하고, 충돌이 없으면 ok. 아니면 why(한국어) */
  | { t: 'merge_info'; taskKey: string; ok: boolean; why?: string };
