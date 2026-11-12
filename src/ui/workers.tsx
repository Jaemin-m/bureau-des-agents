// 일꾼과 할 일을 글로 보여 주는 조각들: 단계 문구, CLI 배지, 할 일 목록. 패널과 창(Rooms)이 함께 쓴다.
import { useMemo } from 'react';
import type { AgentKind, BlockReason, MsgKind, WorkerPhase } from '../../shared/protocol.ts';
import type { TaskStatus } from '../../shared/tasks.ts';
import { dagRows } from '../engine/dag.ts';
import { KIND } from '../engine/kinds.ts';
import { useOffice, type AgentView } from '../state/store.ts';
import { openAgent } from './interact.ts';
import { tidy } from './tidy.ts';

const PHASE_TEXT: Record<WorkerPhase, string> = {
  provisioning: '자리를 준비하는 중', starting: '시작하는 중', working: '일하는 중', blocked: '기다리는 중', idle: '쉬는 중',
  stopping: '멈추는 중', stopped: '멈췄어요', failed: '끝내지 못했어요', retired: '떠났어요',
};

export function phaseText(phase: WorkerPhase, block?: BlockReason, parked?: boolean): string {
  // 프로세스를 놓았어도 멈춘 일꾼은 “멈췄어요”, 질문을 기다리는 일꾼은 “기다려요”라고 말한다
  if (parked && phase === 'idle') return '잠들어 있어요';
  if (phase === 'blocked') return block === 'question' ? '질문의 답을 기다려요' : '허락을 기다려요';
  return PHASE_TEXT[phase];
}

/** worker 이벤트를 받는 일꾼만 단계 문구가 있다. 옛 기록의 팀원은 예전 문구를 그대로 쓴다. */
export const hasPhase = (a: AgentView) => a.phase !== undefined;

export const TASK_TEXT: Record<TaskStatus, string> = {
  waiting: '기다려요', ready: '곧 시작해요', running: '하는 중', blocked: '막혔어요', done: '끝났어요', failed: '실패했어요', cancelled: '취소됐어요',
};

export const MSG_TEXT: Record<MsgKind, string> = { brief: '지시', followup: '이어서 시킴', answer: '답', note: '메모', news: '소식' };

/** 일꾼을 돌리는 CLI의 색 배지. */
export function KindChip({ kind }: { kind: AgentKind }) {
  return <span className="kind-chip" style={{ ['--k' as string]: KIND[kind].color }}>{KIND[kind].label}</span>;
}

/** 할 일 전체 목록: 먼저 끝나야 하는 일 아래에 들여쓰고, 상태와 맡은 일꾼을 보여 준다. */
export function TaskRows() {
  const tasks = useOffice((s) => s.tasks);
  const agents = useOffice((s) => s.agents);
  const rows = useMemo(() => dagRows(tasks), [tasks]);
  return (
    <ul className="tasks">
      {rows.map((r) => {
        const worker = r.node.run.k === 'running' ? agents[r.node.run.worker] : undefined;
        const who = worker ? worker.name : r.node.agent ? KIND[r.node.agent].label : '';
        return (
          <li key={r.key} className={`task ${r.status}`} style={{ paddingLeft: Math.min(r.depth, 4) * 14 }}>
            <i />
            <span className="task-title">{r.title}</span>
            <span className="task-meta">{TASK_TEXT[r.status]}{who ? ` · ${who}` : ''}</span>
            {worker && <button className="task-open" onClick={() => openAgent(worker.id)}>보기</button>}
          </li>
        );
      })}
    </ul>
  );
}

export const speakerName = (id: string, agents: Record<string, AgentView>) => (id === 'chef' ? '맥스' : id === 'user' ? '나' : agents[id]?.name ?? '에이전트');

/** 일꾼의 대화: 맥스의 지시, 사용자의 답과 이어서 시킨 말. */
export function Thread({ a }: { a: AgentView }) {
  const agents = useOffice((s) => s.agents);
  if (!a.thread?.length) return null;
  return (
    <ul className="thread">
      {a.thread.slice(-20).map((m) => (
        <li key={m.id} className={m.from === 'user' ? 'me' : ''}>
          <b>{speakerName(m.from, agents)}</b>
          <em>{MSG_TEXT[m.kind]}</em>
          <span>{tidy(m.text)}</span>
        </li>
      ))}
    </ul>
  );
}
