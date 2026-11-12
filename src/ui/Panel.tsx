// 오른쪽 패널: 맥스의 계획, 일하는 팀(각자 하는 일, 보고서),
// 결과물(만든 파일), 실시간 진행 상황. 미션이 없으면 사용 방법을 보여 준다.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ROLES } from '../../shared/activity.ts';
import type { Role } from '../../shared/protocol.ts';
import { sfx } from '../audio/sfx.ts';
import { robotSprite } from '../engine/robots.ts';
import { teamList, useOffice, type AgentView } from '../state/store.ts';
import { EXAMPLES } from './Dialog.tsx';
import { fmtDate, fmtDuration, tilde } from './format.ts';
import { mdToHtml } from './md.ts';
import { openAgent } from './interact.ts';
import { FileActions } from './Rooms.tsx';
import { tidy } from './tidy.ts';
import { hasPhase, KindChip, phaseText, TaskRows } from './workers.tsx';

export function Avatar({ role, size = 32 }: { role: Role; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const g = ref.current!.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, 20, 24);
    g.drawImage(robotSprite(role, 'stand', 'down', 0, 'open'), 0, 0);
  }, [role]);
  return <canvas ref={ref} width={20} height={24} className="avatar" style={{ width: size * (20 / 24), height: size }} />;
}

const STATUS: Record<AgentView['status'], string> = { working: '일하는 중', reporting: '보고하는 중', done: '일을 마쳤어요', failed: '끝내지 못했어요' };

export function Panel() {
  const mission = useOffice((s) => s.mission);
  return (
    <aside className="panel">
      {mission ? (
        <>
          <PlanSection />
          <TasksSection />
          <TeamSection />
          <FilesSection />
          <FeedSection />
        </>
      ) : <Welcome />}
    </aside>
  );
}

function Welcome() {
  const missions = useOffice((s) => s.missions);
  const dir = useOffice((s) => s.dir);
  const send = useOffice((s) => s.send);
  const connection = useOffice((s) => s.connection);
  return (
    <>
      <section className="card">
        <h3>이렇게 동작해요</h3>
        <ol className="steps">
          <li><b>맥스에게 원하는 걸 말해요.</b> 키보드로도, 목소리로도 돼요.</li>
          <li><b>맥스가 계획을 세우고 팀을 불러요.</b> 다들 자기 자리로 가요(리서치, 코드, 디자인, 글쓰기, 분석).</li>
          <li><b>일하는 모습을 지켜봐요.</b> 말풍선 하나하나가 에이전트가 지금 실제로 하는 일이에요.</li>
          <li><b>결과물을 받아요.</b> 파일이 “결과물”과 내 폴더에 도착해요.</li>
        </ol>
        <p className="small muted">내 컴퓨터에 깔린 진짜 코딩 에이전트(Claude Code, Codex, Gemini)가 일해요. 로봇 옆 작은 색 점이 어느 에이전트인지 알려 줘요.</p>
      </section>
      <section className="card">
        <h3>미션 아이디어</h3>
        <div className="chips col">
          {EXAMPLES.map((e) => <button key={e.label} className="chip" onClick={() => { sfx('click'); useOffice.setState({ draft: e.prompt }); }}>{e.label}</button>)}
        </div>
      </section>
      {connection === 'live' && (
        <section className="card">
          <h3>내 사무실</h3>
          <p className="small muted path">{tilde(dir)}</p>
          <div className="row">
            <button className="btn small" onClick={() => send({ t: 'open_root' })}>폴더 열기</button>
            <button className="btn small" onClick={() => send({ t: 'open_root', rules: true })}>사무실 규칙</button>
          </div>
          <p className="small muted">규칙은 팀이 나에 대해 알아야 할 내용이에요. 맥스가 미션마다 먼저 읽어요.</p>
        </section>
      )}
      {missions.length > 0 && (
        <section className="card">
          <h3>최근 미션</h3>
          {missions.slice(0, 4).map((m) => (
            <div key={m.id} className="mini-mission">
              <div><b>{m.title}</b><span className="small muted">{fmtDate(m.createdAt)} · {fmtDuration(m.workMs)} · 결과물 {m.files.length}개</span></div>
              <div className="row">
                <button className="btn small" onClick={() => { sfx('click'); send({ t: 'replay', missionId: m.id }); }}>다시 재생</button>
                <button className="btn small ghost" onClick={() => send({ t: 'open', missionId: m.id })}>폴더</button>
              </div>
            </div>
          ))}
        </section>
      )}
    </>
  );
}

function TasksSection() {
  const total = useOffice((s) => Object.keys(s.tasks).length);
  const done = useOffice((s) => Object.values(s.tasks).filter((t) => t.run.k === 'done').length);
  if (!total) return null;
  return (
    <section className="card">
      <h3>할 일 <span className="count">{done}/{total}</span></h3>
      <TaskRows />
    </section>
  );
}

/** 할 일 그래프가 있으면 패널은 그쪽을 보여 준다(맥스의 계획은 거기서 나온다). */
function PlanSection() {
  const plan = useOffice((s) => s.plan);
  const hasTasks = useOffice((s) => Object.keys(s.tasks).length > 0);
  if (!plan.length || hasTasks) return null;
  const done = plan.filter((p) => p.status === 'completed').length;
  return (
    <section className="card">
      <h3>계획 <span className="count">{done}/{plan.length}</span></h3>
      <ul className="plan">
        {plan.map((p, i) => <li key={i} className={p.status}><i />{p.text}</li>)}
      </ul>
    </section>
  );
}

function TeamSection() {
  const team = useOffice(useShallow(teamList));
  const [open, setOpen] = useState<string | null>(null);
  const busy = useOffice((s) => s.busySince !== null);
  if (!team.length) {
    return (
      <section className="card">
        <h3>팀</h3>
        <p className="small muted">{busy ? '맥스가 요청을 읽고 누구를 부를지 고르는 중…' : '아직 아무도 부르지 않았어요.'}</p>
      </section>
    );
  }
  const active = team.filter((a) => a.status === 'working' || a.status === 'reporting').length;
  return (
    <section className="card">
      <h3>팀 <span className="count">{active ? `${active}명 일하는 중` : `${team.length}명 다녀감`}</span></h3>
      <div className="team">
        {team.map((a) => <AgentCard key={a.id} a={a} open={open === a.id} onToggle={() => { setOpen(null); openAgent(a.id); }} />)}
      </div>
    </section>
  );
}

function nowText(a: AgentView, working: boolean): string {
  if (hasPhase(a)) {
    const phase = a.phase!;
    return phase === 'working' && a.act ? a.act.label : phaseText(phase, a.block, a.parked);
  }
  return working ? (a.act?.label ?? '자리에 앉는 중…') : `${STATUS[a.status]}${a.leftAt ? ` · ${fmtDuration(a.leftAt - a.hiredAt)}` : ''}`;
}

function AgentCard({ a, open, onToggle }: { a: AgentView; open: boolean; onToggle: () => void }) {
  const role = ROLES[a.role];
  const working = a.status === 'working' || a.status === 'reporting';
  const report = useMemo(() => (open && a.report ? mdToHtml(a.report) : ''), [open, a.report]);
  return (
    <div className={`agent ${a.status} ${open ? 'open' : ''}`} style={{ ['--c' as string]: role.color }}>
      <button className="agent-head" onClick={onToggle}>
        <Avatar role={a.role} size={30} />
        <div className="agent-id">
          <b>{a.name} <span>{role.icon} {role.label}</span>{a.agent && <KindChip kind={a.agent} />}</b>
          <span className="agent-task">{a.task}</span>
          <span className="agent-now">{nowText(a, working)}</span>
        </div>
        <span className={`agent-status ${a.status}`} />
      </button>
      {open && (
        <div className="agent-more">
          <h4>맡은 일(맥스가 작성)</h4>
          <p className="brief">{a.prompt}</p>
          {a.acts.length > 0 && (
            <>
              <h4>한 일</h4>
              <ul className="acts">
                {a.acts.slice(-14).map((x) => <li key={x.id} title={x.detail}>{x.ok === false ? '⚠️ ' : ''}{x.label}</li>)}
              </ul>
            </>
          )}
          {report && (
            <>
              <h4>보고서</h4>
              <div className="md" dangerouslySetInnerHTML={{ __html: report }} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function FileList() {
  const files = useOffice((s) => s.files);
  const mission = useOffice((s) => s.mission);
  const send = useOffice((s) => s.send);
  const replaying = useOffice((s) => s.replaying);
  if (!mission) return null;
  return <FileActions files={files} missionId={mission.id} disabled={replaying} send={send} />;
}

function FilesSection() {
  const files = useOffice((s) => s.files.length);
  const mission = useOffice((s) => s.mission);
  const send = useOffice((s) => s.send);
  const replaying = useOffice((s) => s.replaying);
  return (
    <section className="card">
      <h3>결과물 <span className="count">{files}</span></h3>
      {files ? <FileList /> : <p className="small muted">팀이 만든 파일이 여기(그리고 미션 폴더)에 도착해요.</p>}
      {mission && !replaying && <button className="btn small ghost" onClick={() => send({ t: 'open', missionId: mission.id })}>미션 폴더 열기</button>}
    </section>
  );
}

function FeedSection() {
  const feed = useOffice((s) => s.feed);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [feed.length]);
  return (
    <section className="card">
      <h3>실시간</h3>
      <div className="feed" ref={box}>
        {feed.slice(-60).map((l) => (
          <div key={l.id} className={`feed-line ${l.kind}`}>
            <span className="feed-time">{new Date(l.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
            <b>{l.who}</b> {tidy(l.kind === 'chef' || l.kind === 'user' ? l.text.slice(0, 220) : l.text)}
          </div>
        ))}
      </div>
    </section>
  );
}
