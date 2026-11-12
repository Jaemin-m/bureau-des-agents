// 에이전트 CLI와 사무실 사이의 경계. 이 파일의 타입은 어떤 CLI의 출력 형식도 알지 못한다(stream-json도 마찬가지).
// CLI마다 어댑터 파일이 하나씩 있고, 그 파일을 가져오는 곳은 registry.ts뿐이다.
import type { ActKind, AgentKind } from '../../shared/protocol.ts';

export interface Capabilities {
  /** 턴 도중에 도구 허락을 물을 수 있다 */
  approvals: boolean;
  /** 턴이 도는 중에 메시지를 끼워 넣을 수 있다. false면 진행자가 턴이 끝날 때까지 쥐고 있는다 */
  steer: boolean;
  /** 프로세스 하나가 여러 턴에 걸쳐 세션을 쥐고 있다 */
  liveSession: boolean;
  web: boolean;
  /** 사무실의 도구(MCP)를 붙일 수 있다 */
  hostTools: boolean;
}

export interface AdapterProbe { kind: AgentKind; found: boolean; version?: string; path?: string; vendor: string; caps: Capabilities; note?: string }

/** 직무가 가진 힘: 쓸 수 있는 도구와, 묻지 않고 써도 되는 도구. */
export interface RolePowers { tools: readonly string[]; preapproved: readonly string[] }

/** 다시 이어갈 수 있는 세션. cwd가 달라지면 못 이어가는 CLI가 있어서 같이 들고 다닌다. */
export interface SessionRef { id: string; cwd: string }

/** 개발용 녹화(BUREAU_RECORD)가 CLI와 오가는 원문 줄을 받는 곳. */
export interface RawTap { raw(dir: 'stdout' | 'stdin', line: string): void }

/** CLI가 알아야 할 것을 사무실의 말로 적은 것. 어댑터가 자기 CLI의 옵션으로 옮긴다. */
export interface SessionSpec {
  cwd: string;
  powers: RolePowers;
  /** 'read'는 파일을 쓰거나 고치지 못하고 명령도 못 실행한다 */
  access: 'read' | 'write';
  /** 사무실 설정: 'ask'는 파일 수정 외의 위험한 일을 묻고, 'auto'는 스스로 정한다 */
  autonomy: 'ask' | 'auto';
  systemPrompt: string;
  model?: string;
  resume?: SessionRef;
  /** 사무실이 붙이는 MCP 서버(인라인 JSON) */
  mcpConfig?: string;
  /** 위 MCP 설정만 쓴다(사용자의 다른 커넥터는 보이지 않는다) */
  strictMcp?: boolean;
  tap?: RawTap;
}

export interface TurnInput { text: string }

export interface PlanStep { text: string; status: 'pending' | 'in_progress' | 'completed' }

/** 어댑터가 내보내는, 이미 읽어 낸 CLI 중립의 신호. */
export type WorkerSignal =
  | { k: 'session'; ref: SessionRef; model?: string }
  | { k: 'think' }
  /** 어댑터가 120ms마다 한 번으로 줄인다. 기록하지 않는다 */
  | { k: 'typing'; text: string }
  | { k: 'say'; text: string }
  | { k: 'plan'; items: PlanStep[] }
  | { k: 'act'; id: string; kind: ActKind; tool: string; label: string; detail: string }
  | { k: 'act_done'; id: string; ok: boolean }
  | { k: 'approval'; id: string; tool: string; label: string; detail: string; full: boolean }
  | { k: 'approval_cancelled'; id: string }
  | { k: 'quota'; fiveHour: number; resetsAt: number | null }
  | { k: 'usage'; tokens: number; tools: number }
  /** 턴 하나가 끝났다. text = 마지막 답. interrupted = 중단해서 끝났다 */
  | { k: 'turn_end'; text: string; ok: boolean; interrupted: boolean; error?: string }
  | { k: 'exit'; code: number | null; signal: string | null; expected: boolean; stderrTail: string }
  /** 읽을 수 없는 출력 줄(배너 등). 개수와 길이를 제한해서 디버그용으로만 쓴다 */
  | { k: 'diag'; line: string };

export type Sink = (s: WorkerSignal) => void;

/**
 * 논리적인 세션 하나. 약속:
 *  - 받아들인 턴마다 `turn_end`가 정확히 하나 온다. 프로세스가 죽어도 마찬가지다(ok: false). 단 kill() 뒤에는 오지 않는다.
 *  - kill() 뒤에는 `exit` 하나 말고는 아무 신호도 오지 않는다.
 *  - send(…, 'steer')는 caps.steer일 때만 쓴다. 아니면 던진다.
 *  - 프로세스가 끝난 뒤의 send는 던진다: 이어서 하려면 spec.resume으로 다시 open한다.
 */
export interface AgentSession {
  send(turn: TurnInput, mode: 'turn' | 'steer'): void;
  answerApproval(id: string, allow: boolean): void;
  interrupt(): void;
  /** 입력을 닫아 프로세스를 내려놓는다. 세션은 다시 이어갈 수 있다. 프로세스가 사라지면 끝난다 */
  park(): Promise<void>;
  kill(): void;
  readonly alive: boolean;
  readonly pid: number | undefined;
}

export interface AgentAdapter {
  readonly kind: AgentKind;
  /** 설치와 버전을 확인한다. 모델을 부르지 않는다 */
  probe(): Promise<AdapterProbe>;
  /** 첫 턴을 바로 시작한다. */
  open(spec: SessionSpec, first: TurnInput, sink: Sink): AgentSession;
}
