// 일꾼과 할 일을 글로 보여 주는 조각들: 단계 문구, CLI 배지, 할 일 목록. 패널과 창(Rooms)이 함께 쓴다.
import { useEffect, useMemo, useState } from 'react';
import type { AgentKind, BlockReason, MsgKind, TaskResult, WorkerPhase } from '../../shared/protocol.ts';
import { sfx } from '../audio/sfx.ts';
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

export const MSG_TEXT: Record<MsgKind, string> = { brief: '지시', followup: '이어서 시킴', answer: '답', question: '질문', note: '메모', news: '소식' };

/** 일꾼을 돌리는 CLI의 색 배지. */
export function KindChip({ kind }: { kind: AgentKind }) {
  return <span className="kind-chip" style={{ ['--k' as string]: KIND[kind].color }}>{KIND[kind].label}</span>;
}

/** 할 일 전체 목록: 먼저 끝나야 하는 일 아래에 들여쓰고, 상태와 맡은 일꾼, 저장소 미션이면 브랜치를 보여 준다. */
export function TaskRows() {
  const tasks = useOffice((s) => s.tasks);
  const agents = useOffice((s) => s.agents);
  const rows = useMemo(() => dagRows(tasks), [tasks]);
  return (
    <ul className="tasks">
      {rows.map((r) => {
        const result = r.node.run.k === 'done' ? r.node.run.result : undefined;
        const workerId = r.node.run.k === 'running' ? r.node.run.worker : result?.by;
        const worker = workerId ? agents[workerId] : undefined;
        const who = worker ? worker.name : r.node.agent ? KIND[r.node.agent].label : '';
        return (
          <li key={r.key} className={`task ${r.status}`} style={{ paddingLeft: Math.min(r.depth, 4) * 14 }}>
            <i />
            <span className="task-title">{r.title}</span>
            <span className="task-meta">{TASK_TEXT[r.status]}{who ? ` · ${who}` : ''}</span>
            {worker && <button className="task-open" onClick={() => openAgent(worker.id)}>보기</button>}
            {result?.branch && <BranchLine result={result} />}
          </li>
        );
      })}
    </ul>
  );
}

const MERGEABLE_TEXT: Record<NonNullable<TaskResult['mergeable']>, string> = { clean: '충돌 없음', conflict: '충돌 있음', unknown: '확인 못 함' };

/** 브랜치 한 줄: 이름, 바뀐 양, 합칠 수 있는지(또는 합쳤는지, 버렸는지). */
export function BranchLine({ result }: { result: TaskResult }) {
  const state = result.merged ? 'merged' : result.archived ? 'archived' : result.mergeable ?? 'unknown';
  const badge = result.merged ? `${result.base ?? '기준'}에 합쳤어요` : result.archived ? '보관함에 있어요' : MERGEABLE_TEXT[result.mergeable ?? 'unknown'];
  return (
    <span className="branch-line">
      <code className="branch-name">{result.branch}</code>
      <span className="branch-stat">파일 {result.files ?? 0}개 <b className="ins">+{result.ins ?? 0}</b> <b className="del">−{result.del ?? 0}</b></span>
      <span className={`branch-badge ${state}`}>{badge}</span>
    </span>
  );
}

/** 일꾼 카드의 브랜치: 사용자만 누를 수 있는 합치기와 버리기. 합치기는 서버가 지금 된다고 할 때만 켜진다. */
export function BranchCard({ taskKey }: { taskKey: string }) {
  const task = useOffice((s) => s.tasks[taskKey]);
  const info = useOffice((s) => s.mergeInfo[taskKey]);
  const replaying = useOffice((s) => s.replaying);
  const send = useOffice((s) => s.send);
  const label = useOffice((s) => (s.mission?.target?.kind === 'repo' ? s.mission.target.label : '저장소'));
  const [confirm, setConfirm] = useState(false);
  const result = task?.run.k === 'done' ? task.run.result : undefined;
  const open = !!result?.branch && !result.merged && !result.archived;
  const head = result?.head;
  useEffect(() => { if (open && !replaying) send({ t: 'merge_check', taskKey }); }, [open, head, replaying, taskKey, send]);
  if (!result?.branch) return null;
  const why = !info ? '합칠 수 있는지 확인하는 중이에요.' : info.ok ? '' : tidy(info.why ?? '');
  return (
    <div className="branch-card" data-task={taskKey}>
      <div className="branch-card-head"><b>{task.title}</b></div>
      <BranchLine result={result} />
      {open && !replaying && (
        <>
          <div className="branch-actions">
            <button className="btn primary small merge" disabled={!info?.ok} title={why || `${label}의 ${result.base}에 합쳐요`} onClick={() => { sfx('click'); send({ t: 'merge', taskKey }); }}>합치기</button>
            {!confirm
              ? <button className="btn ghost small discard" onClick={() => setConfirm(true)}>버리기</button>
              : <button className="btn stop small discard" onClick={() => { sfx('click'); setConfirm(false); send({ t: 'discard_branch', taskKey }); }}>정말 버리기</button>}
          </div>
          {why && <p className="small muted branch-why">{why}</p>}
          {confirm && <p className="small muted">버리면 일꾼이 사무실을 떠나고, 브랜치는 지우지 않고 보관함으로 옮겨요. 나중에 되살릴 수 있어요.</p>}
        </>
      )}
      {result.archived && <p className="small muted">브랜치는 지우지 않았어요. 보관함(refs/bureau/archive)에 있어서 되살릴 수 있어요.</p>}
    </div>
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
