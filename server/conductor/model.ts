// Conductor의 데이터 모델. 한 미션의 상태 전부이고, 쓰는 곳은 step.ts 하나뿐이다. 입출력 없음.
import type { AgentKind, MissionStatus, Role, TaskRun, WorkerPhase } from '../../shared/protocol.ts';

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** `w-<seq>-<salt>`. 사무실이 만들고, 모델이 만들지 않는다. */
export type WorkerId = Brand<string, 'WorkerId'>;
/** 맥스가 office_plan에서 고른 키(`[a-z0-9-]`), 이어서 시킨 일은 `f.<seq>`. 키가 곧 id다. */
export type TaskKey = Brand<string, 'TaskKey'>;
export type QuestionId = Brand<string, 'QuestionId'>;
export type MessageId = Brand<string, 'MessageId'>;
/** 화면에 보이는 도구 허락 요청 id. CLI가 준 id(approvalId)와 따로 둔다. */
export type RequestId = Brand<string, 'RequestId'>;

export const LEAD = 'chef';
export type Who = typeof LEAD | WorkerId;

/** 셸만 아는 값(세션 참조, 작업 공간). 코어는 들여다보지 않고 저장했다가 돌려준다. */
export type Opaque = { readonly [k: string]: unknown };

export type MemberRole = Exclude<Role, 'chef'>;
export type Access = 'read' | 'write';

export interface TaskSpec {
  key: TaskKey;
  title: string;
  brief: string;
  role: MemberRole;
  agent: AgentKind;
  access: Access;
  after: TaskKey[];
  /** 이 일꾼만 이 일을 한다(이어서 시킨 일) */
  pin?: WorkerId;
}

export type Run = Exclude<TaskRun, { k: 'running' }> | { k: 'running'; worker: WorkerId };

export interface Task extends TaskSpec {
  /** 만든 순서. 키가 숫자처럼 생겨도 순서가 흔들리지 않게 */
  n: number;
  origin: 'plan' | 'followup';
  run: Run;
  /** 이 일을 맡았던 자리. 멈췄다 다시 시작하면 같은 세션·작업 공간에서 잇는다 */
  seat?: WorkerId;
  turns: number;
  /** 시작하기 전에 멈춰서 전하지 못한 턴 글 */
  carry?: string;
}

export type Block =
  | { reason: 'approval'; requestId: RequestId; approvalId: string }
  | { reason: 'question'; question: QuestionId };

/**
 * provisioning·starting은 보낼 턴 글을 들고 있고, sent는 그 효과를 이미 냈는지다(converge가 두 번 내지 않게).
 * stopping은 멈춘 뒤 어디에 내려앉을지 안다.
 */
export type Phase =
  | { k: 'provisioning'; turn: string; sent: boolean }
  | { k: 'starting'; turn: string; sent: boolean }
  | { k: 'working' }
  | { k: 'blocked'; on: Block }
  | { k: 'stopping'; then: 'idle' | 'stopped' | 'retired'; killed: boolean }
  | { k: 'idle' }
  | { k: 'stopped' }
  | { k: 'failed' }
  | { k: 'retired' };

export type LeadPhase = Exclude<Phase, { k: 'provisioning' | 'retired' }>;

/** 하나뿐인 합법 이동표. 화면 단계(WorkerPhase)와 같은 이름을 쓴다. */
export const NEXT_PHASE: Readonly<Record<WorkerPhase, readonly WorkerPhase[]>> = {
  provisioning: ['starting', 'failed', 'idle', 'stopped', 'retired'],
  starting: ['working', 'failed', 'stopping', 'idle', 'stopped', 'retired'],
  working: ['blocked', 'idle', 'stopping'],
  blocked: ['working', 'starting', 'stopping', 'idle', 'stopped', 'retired'],
  idle: ['provisioning', 'starting', 'retired'],
  stopping: ['idle', 'stopped', 'retired'],
  stopped: ['idle', 'retired'],
  failed: ['idle', 'retired'],
  retired: [],
};

export function moveTo(from: WorkerPhase, to: WorkerPhase): WorkerPhase {
  if (!NEXT_PHASE[from].includes(to)) throw new Error(`일꾼 단계를 ${from}에서 ${to}로 옮길 수 없어요.`);
  return to;
}

export interface Message { id: MessageId; from: 'user' | typeof LEAD; kind: 'followup' | 'answer' | 'note'; text: string }

interface WorkerCore {
  agent: AgentKind;
  /** open_session마다 1씩 오른다. 예전 프로세스가 늦게 보낸 신호는 gen이 달라서 버린다 */
  gen: number;
  /** 단계와 따로: 지금 프로세스를 쥐고 있는가 */
  residency: 'live' | 'parked';
  session?: Opaque;
  /** 턴 경계에서만 전한다 */
  inbox: Message[];
  startFailures: number;
  turns: number;
}

export interface Lead extends WorkerCore { kind: 'lead'; id: typeof LEAD; phase: LeadPhase }

export interface Member extends WorkerCore {
  kind: 'member';
  id: WorkerId;
  role: MemberRole;
  name: string;
  access: Access;
  workspace?: Opaque;
  phase: Phase;
}

export type Worker = Lead | Member;

export type QuestionState = { k: 'open' } | { k: 'answered'; by: 'user' | typeof LEAD; text: string } | { k: 'void' };

/** 일꾼이 턴을 질문으로 끝냄. 먼저 맥스에게 가고, 맥스가 다음 턴에 답하지 않으면 사용자에게 간다. 먼저 온 답이 이긴다. */
export interface Question {
  id: QuestionId;
  from: WorkerId;
  task: TaskKey;
  text: string;
  options?: string[];
  audience: 'lead' | 'user';
  /** 맥스를 깨우는 글에 이미 실었는가 */
  told: boolean;
  state: QuestionState;
}

/** 맥스에게 아직 전하지 않은 소식. line은 사무실이 쓴 글, data는 일꾼이 쓴 글(지시가 아니라 자료). */
export interface NewsItem { id: string; line: string; data?: string; question?: QuestionId }

export interface Limits {
  maxLive: number;
  maxWorkers: number;
  maxTasks: number;
  startFailureLimit: number;
  newsDebounceMs: number;
  stopGraceMs: number;
}

export const DEFAULT_LIMITS: Limits = { maxLive: 4, maxWorkers: 12, maxTasks: 60, startFailureLimit: 3, newsDebounceMs: 1500, stopGraceMs: 5000 };

export interface MissionState {
  v: 1;
  status: MissionStatus;
  /** 단조 증가. id가 재시작 뒤에도 겹치지 않는다 */
  seq: number;
  tasks: Record<string, Task>;
  lead: Lead;
  workers: Record<string, Member>;
  questions: Record<string, Question>;
  news: NewsItem[];
  /** 소식을 모아 맥스를 깨울 시각 */
  wakeAt: number | null;
  /** 맥스가 마지막 턴에 한 말. settle 글이 된다 */
  leadLast: string;
  /** office_message의 requestId. 같은 id는 두 번 처리하지 않는다 */
  requests: string[];
  limits: Limits;
}

/** 프로세스나 턴을 붙잡고 있는 단계. maxLive를 센다 */
export const busy = (p: Phase): boolean =>
  p.k === 'provisioning' || p.k === 'starting' || p.k === 'working' || p.k === 'stopping' || (p.k === 'blocked' && p.on.reason === 'approval');
