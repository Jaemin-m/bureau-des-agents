// 사무실을 클릭하면 열리는 창들. 내용은 전부 진짜 에이전트 CLI에서 온다:
// 에이전트 카드(맡은 일, 모든 작업, 보고서), 맥스의 계획과 그 기록,
// 팀과 도구, 머신, 결과물, 만든 사이트의 미리보기.
import { useEffect, useMemo, useState } from 'react';
import { ROLE_TOOLS, ROLES, TOOL_INFO } from '../../shared/activity.ts';
import type { PlanItem, Role } from '../../shared/protocol.ts';
import { taskOf } from '../../shared/tasks.ts';
import { KIND, agentList } from '../engine/kinds.ts';
import { jukebox, TRACKS } from '../audio/music.ts';
import { sfx } from '../audio/sfx.ts';
import { world } from '../engine/instance.ts';
import { canStopWorker, openAsks, savePref, teamList, useOffice, type ActView, type AgentView, type Tod } from '../state/store.ts';
import { useShallow } from 'zustand/react/shallow';
import { fileIcon, fmtClock, fmtDate, fmtDuration, fmtSize, plural, readable, tilde } from './format.ts';
import { openAgent, party } from './interact.ts';
import { mdToHtml } from './md.ts';
import { Avatar } from './Panel.tsx';
import { tidy } from './tidy.ts';
import { AskCard } from './Asks.tsx';
import { BranchCard, hasPhase, KindChip, phaseText, TaskRows, Thread, tone } from './workers.tsx';

const ICON: Record<string, string> = {
  search: '🔎', web: '🌐', read: '📖', write: '✍️', edit: '✏️', bash: '💻', plan: '📋', skill: '🎓', mcp: '🔌', other: '⚙️',
};

function Shell({ title, sub, wide, children, onClose }: { title: React.ReactNode; sub?: React.ReactNode; wide?: boolean; children: React.ReactNode; onClose?: () => void }) {
  const close = onClose ?? (() => useOffice.setState({ modal: null }));
  return (
    <div className="modal-back" onClick={close}>
      <div className={`modal room ${wide ? 'wide' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div className="room-title"><b>{title}</b>{sub && <span>{sub}</span>}</div>
          <button className="close" onClick={close} aria-label="닫기">×</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

/** 사무실 창들(한 번에 하나만 열린다). */
export function Rooms() {
  const modal = useOffice((s) => s.modal);
  if (!modal) return null;
  switch (modal.kind) {
    case 'agent': return <AgentRoom id={modal.id} />;
    case 'board': return <BoardRoom />;
    case 'clock': return <ClockRoom />;
    case 'machine': return <MachineRoom />;
    case 'jukebox': return <JukeboxRoom />;
    case 'team': return <TeamRoom role={modal.role} />;
    case 'files': return <FilesRoom />;
    case 'preview': return <PreviewRoom missionId={modal.missionId} file={modal.file} />;
  }
}

// ── 에이전트 카드 ──
function AgentRoom({ id }: { id: string }) {
  const a = useOffice((s) => s.agents[id]);
  const current = useOffice((s) => taskOf(s.tasks, id));
  const branches = useOffice(useShallow((s) => Object.values(s.tasks).flatMap((t) => (t.run.k === 'done' && t.run.result.by === id && t.run.result.branch ? [t.key] : []))));
  const live = world.actors.get(id);
  const html = useMemo(() => (a?.report ? mdToHtml(tidy(a.report)) : ''), [a?.report]);
  if (!a) return <Shell title="이 에이전트는 이제 없어요">사무실을 떠났어요.</Shell>;
  const role = ROLES[a.role];
  const working = a.status === 'working' || a.status === 'reporting';
  return (
    <Shell title={<>{a.name}</>} sub={`${role.icon} ${role.label} · ${a.task}`}>
      <div className="agent-hero" style={{ ['--c' as string]: role.color }}>
        <Avatar role={a.role} size={72} />
        <div>
          <span className={`pill-status ${tone(a)}`}>{hasPhase(a) ? phaseText(a.phase!, a.block, a.parked) : working ? (live?.seated ? '일하는 중' : '가는 중') : a.status === 'done' ? '일을 마쳤어요' : '끝내지 못했어요'}</span>
          <p className="now">{working && a.act ? <><i>{ICON[a.act.kind]}</i>{a.act.label}</> : a.status === 'done' ? '보고서가 맥스의 책상 위에 있어요.' : working ? '자리에 앉는 중…' : ''}</p>
          {current && <p className="small">맡은 할 일: <b>{current.title}</b></p>}
          {a.agent
            ? <p className="small muted"><KindChip kind={a.agent} /> {KIND[a.agent].label}가 해요. 직무는 {role.label}이에요.</p>
            : <p className="small muted">Claude Code가 해요(서브에이전트 “{role.type || 'renfort'}”). 쓰는 도구: {ROLE_TOOLS[a.role].join(', ') || '맥스와 같은 도구'}.</p>}
        </div>
      </div>
      <section className="room-sec">
        <h4>맥스가 맡긴 일</h4>
        <p className="brief">{tidy(a.prompt)}</p>
      </section>
      {branches.length > 0 && (
        <section className="room-sec">
          <h4>브랜치 <span className="count">{plural(branches.length, '개')}</span></h4>
          {branches.map((k) => <BranchCard key={k} taskKey={k} />)}
        </section>
      )}
      <WorkerTalk a={a} />
      {a.acts.length > 0 && (
        <section className="room-sec">
          <h4>한 일 <span className="count">작업 {plural(a.acts.length, '개')}</span></h4>
          <ActList acts={a.acts} />
        </section>
      )}
      {html && (
        <section className="room-sec">
          <h4>보고서</h4>
          <div className="md report" dangerouslySetInnerHTML={{ __html: html }} />
        </section>
      )}
      {a.leftAt && (
        <p className="small muted">{fmtDuration(a.leftAt - a.hiredAt)} 동안 일함{a.tools ? ` · 도구 ${plural(a.tools, '번')} 사용` : ''}{a.tokens ? ` · 토큰 ${a.tokens.toLocaleString('ko-KR')}개` : ''}</p>
      )}
    </Shell>
  );
}

/** 일꾼과 주고받은 말, 열린 질문, 이 일꾼에게만 하는 말과 멈추기. */
function WorkerTalk({ a }: { a: AgentView }) {
  const asks = useOffice(useShallow((s) => openAsks(s.asks).filter((k) => k.who === a.id)));
  const replaying = useOffice((s) => s.replaying);
  const send = useOffice((s) => s.send);
  const [text, setText] = useState('');
  const resting = !canStopWorker(a);
  const submit = () => {
    const t = text.trim();
    if (!t || replaying) return;
    sfx('send');
    send({ t: 'say', text: t, to: a.id });
    setText('');
  };
  return (
    <section className="room-sec">
      <h4>대화 {a.thread?.length ? <span className="count">{plural(a.thread.length, '건')}</span> : null}</h4>
      {asks.map((k) => <AskCard key={k.requestId} ask={k} />)}
      <Thread a={a} />
      {!a.thread?.length && !asks.length && <p className="muted small">아직 주고받은 말이 없어요.</p>}
      {!replaying && (
        <div className="worker-talk">
          <textarea
            value={text}
            rows={2}
            placeholder={resting ? `${a.name}에게 이어서 시킬 일을 적어 주세요.` : `${a.name}에게 할 말을 적어 주세요.`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }}
          />
          <div className="worker-talk-actions">
            <button className="btn primary small" disabled={!text.trim()} onClick={submit}>{a.name}에게 보내기</button>
            {!resting && <button className="btn stop small" onClick={() => { sfx('click'); send({ t: 'stop', who: a.id }); }}>■ {a.name}만 멈추기</button>}
          </div>
        </div>
      )}
    </section>
  );
}

function ActList({ acts }: { acts: ActView[] }) {
  return (
    <ul className="act-list">
      {acts.slice(-40).map((x) => (
        <li key={x.id} className={x.ok === false ? 'fail' : ''}>
          <i>{ICON[x.kind]}</i>
          <div>
            <span>{x.label}</span>
            {x.detail && x.detail !== x.label && <code>{(() => { const d = tidy(x.detail); return d.length > 160 ? d.slice(0, 159) + '…' : d; })()}</code>}
          </div>
          <time>{new Date(x.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
        </li>
      ))}
    </ul>
  );
}

// ── 화이트보드: 계획, 누가 무엇을 하는지, 계획의 기록 ──
function planChanges(prev: PlanItem[] | null, next: PlanItem[]): string[] {
  if (!prev) return [`맥스가 계획을 써요: ${plural(next.length, '단계')}`];
  const out: string[] = [];
  for (const it of next) {
    const before = prev.find((p) => p.text === it.text);
    if (!before) out.push(`+ ${it.text}`);
    else if (before.status !== it.status && it.status === 'completed') out.push(`✓ ${it.text}`);
    else if (before.status !== it.status && it.status === 'in_progress') out.push(`▶ ${it.text}`);
  }
  return out;
}

function BoardRoom() {
  const plan = useOffice((s) => s.plan);
  const history = useOffice((s) => s.planHistory);
  const taskCount = useOffice((s) => Object.keys(s.tasks).length);
  const taskDone = useOffice((s) => Object.values(s.tasks).filter((t) => t.run.k === 'done').length);
  const team = useOffice(useShallow(teamList));
  const done = plan.filter((p) => p.status === 'completed').length;
  const steps = useMemo(() => history.map((h, i) => ({ at: h.at, lines: planChanges(i ? history[i - 1].items : null, h.items) })).filter((x) => x.lines.length), [history]);
  return (
    <Shell title="맥스의 화이트보드" sub={taskCount ? `할 일 ${taskCount}개 중 ${taskDone}개 완료` : plan.length ? `${plan.length}단계 중 ${done}단계 완료` : '미션 계획과 누가 무엇을 하는지'}>
      {taskCount > 0 ? (
        <>
          <div className="progress"><i style={{ width: `${(taskDone / taskCount) * 100}%` }} /></div>
          <TaskRows />
        </>
      ) : plan.length > 0 ? (
        <>
          <div className="progress"><i style={{ width: `${(done / plan.length) * 100}%` }} /></div>
          <ul className="plan big">{plan.map((p, i) => <li key={i} className={p.status}><i />{p.text}</li>)}</ul>
        </>
      ) : <p className="muted">아직 계획이 없어요. 미션에 단계가 여러 개면 맥스가 계획을 써요.</p>}
      <section className="room-sec">
        <h4>누가 무엇을 <span className="count">에이전트 {plural(team.length, '명')}</span></h4>
        {team.length ? (
          <div className="who">
            {team.map((a) => (
              <button key={a.id} className={`who-row ${a.status}`} style={{ ['--c' as string]: ROLES[a.role].color }} onClick={() => openAgent(a.id)}>
                <Avatar role={a.role} size={26} />
                <b>{a.name}{a.agent && <> <KindChip kind={a.agent} /></>}</b>
                <span className="who-task">{a.task}</span>
                <span className="who-state">{hasPhase(a) ? phaseText(a.phase!, a.block, a.parked) : a.status === 'done' ? '✓ 보고 완료' : a.status === 'failed' ? '✕ 못 끝냄' : a.status === 'reporting' ? '📄 보고하는 중' : '… 일하는 중'}</span>
              </button>
            ))}
          </div>
        ) : <p className="muted small">아직 아무도 없어요.</p>}
      </section>
      {steps.length > 0 && (
        <section className="room-sec">
          <h4>계획 기록</h4>
          <ol className="timeline">
            {steps.map((s, i) => (
              <li key={i}>
                <time>{new Date(s.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
                <div>{s.lines.map((l, j) => <span key={j}>{l}</span>)}</div>
              </li>
            ))}
          </ol>
        </section>
      )}
    </Shell>
  );
}

// ── 시계 ──
function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  return now;
}

const TODS: [Tod, string][] = [['auto', 'Mac 시간대로'], ['day', '☀️ 낮'], ['evening', '🌇 저녁'], ['night', '🌙 밤']];

function ClockRoom() {
  const now = useClock();
  const tod = useOffice((s) => s.tod);
  const busySince = useOffice((s) => s.busySince);
  const workMs = useOffice((s) => s.workMs);
  const mission = useOffice((s) => s.mission);
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return (
    <Shell title="사무실 시계" sub={now.toLocaleDateString('ko-KR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}>
      <div className="big-clock"><span>{hh}</span><i>:</i><span>{mm}</span><small>{ss}</small></div>
      {mission && (busySince
        ? <p className="center">미션 진행 시간 <b>{fmtClock(workMs + (now.getTime() - busySince))}</b> · {mission.title}</p>
        : <p className="center">지난 미션: <b>{fmtClock(workMs)}</b> 동안 일함 · {mission.title}</p>)}
      <p className="center muted small">팀은 잠들지 않아요. 새벽 3시에도 낮 12시처럼 일해요.</p>
      <div className="seg">
        {TODS.map(([v, l]) => (
          <button key={v} className={tod === v ? 'on' : ''} onClick={() => { sfx('click'); useOffice.setState({ tod: v }); savePref('tod', v); }}>{l}</button>
        ))}
      </div>
    </Shell>
  );
}

// ── 머신(서버): Claude Code, 모델, 구독 ──
function MachineRoom() {
  const agents = useOffice((s) => agentList(s.installed));
  const claude = useOffice((s) => s.claude);
  const settings = useOffice((s) => s.settings);
  const mission = useOffice((s) => s.mission);
  const quota = useOffice((s) => s.quota);
  const dir = useOffice((s) => s.dir);
  const connection = useOffice((s) => s.connection);
  const rows: [string, React.ReactNode][] = [
    ['Claude Code', claude?.found ? `${claude.version} · ${tilde(claude.path ?? '')}` : connection === 'demo' ? '데모(실제 미션 다시 재생)' : '찾을 수 없음'],
    ['연결', '내 Claude 구독(API 키 없음, 사용량 과금 없음)'],
    ['맥스의 두뇌', mission?.model ? `${mission.model} (설정: ${settings.chefModel || '기본값'})` : settings.chefModel || '기본값'],
    ['팀의 두뇌', settings.teamModel === 'inherit' ? '맥스와 같음' : settings.teamModel],
    ['허락', settings.permission === 'auto' ? '자동: 위험한 작업만 에이전트가 물어봐요' : '명령마다 물어봐요'],
    ['에너지(5시간)', quota ? `${Math.round(quota.fiveHour * 100)}% 사용${quota.resetsAt ? `, ${new Date(quota.resetsAt * 1000).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}에 충전` : ''}` : '아직 측정 전'],
    ['사무실 폴더', dir ? tilde(dir) : '—'],
    ['진행 중인 미션', mission ? tilde(mission.folder) : '없음'],
  ];
  return (
    <Shell title="머신" sub="사무실 뒤에서 돌아가는 것">
      <dl className="kv">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
      <section className="room-sec">
        <h4>어떻게 동작하나요</h4>
        <p className="small">맥스는 미션 폴더에서 창 없이 실행되는 진짜 Claude Code 세션이에요. 팀원은 진짜 코딩 에이전트 CLI{agents}가 돌려요. 어느 CLI인지는 로봇 머리 옆의 작은 색 점으로 보여요. 에이전트가 도구를 쓸 때마다(검색, 페이지 읽기, 파일 쓰기) 사무실에 알려 주고, 사무실은 그걸 바로 보여 줘요. 타자 치는 로봇, 말풍선, 팀장 책상에 놓이는 보고서처럼요. 예전 미션의 팀원은 Claude Code 서브에이전트였어요.</p>
        <p className="small muted">제한 모드: 팀은 미션 폴더 밖으로 나가지 않고, 내 설정이나 다른 에이전트도 사무실에 끼어들지 않아요.</p>
      </section>
    </Shell>
  );
}

// ── 주크박스 ──
function JukeboxRoom() {
  const music = useOffice((s) => s.music);
  const tr = TRACKS[music.index];
  return (
    <Shell title="주크박스" sub="일할 때 듣는 하우스 음악(퇴근 후에도)">
      <div className="now-playing">
        <div className={`vinyl ${music.playing ? 'spin' : ''}`}><i /></div>
        <div>
          <b>{tr.title}</b>
          <span>{tr.mood}</span>
          <div className="row">
            <button className="btn small" onClick={() => jukebox.prev()} aria-label="이전 곡">⏮</button>
            <button className="btn primary small" onClick={() => jukebox.toggle()}>{music.playing ? '⏸ 일시정지' : '▶ 재생'}</button>
            <button className="btn small" onClick={() => jukebox.next()} aria-label="다음 곡">⏭</button>
          </div>
        </div>
      </div>
      <label className="field volume">
        <span>음량</span>
        <input type="range" min={0} max={1} step={0.01} value={music.volume} onChange={(e) => jukebox.setVolume(Number(e.target.value))} />
      </label>
      <ul className="tracks">
        {TRACKS.map((t, i) => (
          <li key={t.id}>
            <button className={i === music.index ? 'on' : ''} onClick={() => jukebox.play(i)}>
              <span>{i === music.index && music.playing ? '♪' : i + 1}</span>
              <b>{t.title}</b>
              <em>{t.mood}</em>
            </button>
          </li>
        ))}
      </ul>
      <div className="row">
        <button className="btn" onClick={() => { useOffice.setState({ modal: null }); party(); }}>🪩 저녁 모드</button>
        <span className="small muted">이 사무실을 위해 ElevenLabs Music과 Google Lyria로 만든 오리지널 곡이에요.</span>
      </div>
    </Shell>
  );
}

// ── 팀 전체: 직무와 도구, 진행 중인 미션, 기록 ──
function TeamRoom({ role }: { role?: Role }) {
  const agents = useOffice((s) => agentList(s.installed));
  const [tab, setTab] = useState<'roles' | 'now' | 'history'>(role ? 'roles' : 'now');
  const team = useOffice(useShallow(teamList));
  const settings = useOffice((s) => s.settings);
  const history = useOffice((s) => s.teamHistory);
  const send = useOffice((s) => s.send);
  const connection = useOffice((s) => s.connection);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { if (tab === 'history' && connection === 'live') send({ t: 'team_history' }); }, [tab, connection, send]);
  const working = (r: Role) => [...world.actors.values()].filter((a) => a.role === r && a.seated).length;
  const roles: Role[] = ['chef', 'recherche', 'code', 'design', 'redaction', 'analyse'];
  const missions = useMemo(() => {
    const m = new Map<string, { title: string; at: number; entries: NonNullable<typeof history> }>();
    for (const e of history ?? []) {
      if (!m.has(e.missionId)) m.set(e.missionId, { title: e.missionTitle, at: e.at, entries: [] });
      m.get(e.missionId)!.entries.push(e);
    }
    return [...m.entries()];
  }, [history]);
  return (
    <Shell title="팀 전체" sub={`저마다 직무를 가진 진짜 코딩 에이전트${agents}`} wide>
      <div className="seg tabs">
        <button className={tab === 'now' ? 'on' : ''} onClick={() => setTab('now')}>이번 미션</button>
        <button className={tab === 'roles' ? 'on' : ''} onClick={() => setTab('roles')}>직무</button>
        <button className={tab === 'history' ? 'on' : ''} onClick={() => setTab('history')}>기록</button>
      </div>
      {tab === 'now' && (team.length ? (
        <div className="who">
          {team.map((a) => (
            <button key={a.id} className={`who-row ${a.status}`} style={{ ['--c' as string]: ROLES[a.role].color }} onClick={() => { sfx('open'); useOffice.setState({ modal: { kind: 'agent', id: a.id } }); }}>
              <Avatar role={a.role} size={26} />
              <b>{a.name}</b>
              <span className="who-task">{ROLES[a.role].icon} {a.task}</span>
              <span className="who-state">{a.status === 'done' ? '✓ 보고 완료' : a.status === 'failed' ? '✕ 못 끝냄' : a.act ? a.act.label : '… 일하는 중'}</span>
            </button>
          ))}
        </div>
      ) : <p className="muted">아직 사무실에 아무도 없어요. 맥스에게 미션을 주면 알맞은 에이전트를 불러요.</p>)}
      {tab === 'roles' && (
        <div className="roles">
          {roles.map((r) => (
            <div key={r} className={`role-card ${role === r ? 'focus' : ''}`} style={{ ['--c' as string]: ROLES[r].color }}>
              <div className="role-head"><Avatar role={r} size={34} /><div><b>{ROLES[r].icon} {ROLES[r].label}</b><span>{r === 'chef' ? '맥스' : `에이전트 “${ROLES[r].type}”`} · 두뇌: {r === 'chef' ? settings.chefModel || '기본값' : settings.teamModel === 'inherit' ? '맥스와 같음' : settings.teamModel}</span></div>{working(r) > 0 && <em>{working(r)}명 일하는 중</em>}</div>
              <p>{ROLES[r].what}</p>
              <div className="tools">{ROLE_TOOLS[r].map((t) => <span key={t} title={TOOL_INFO[t] ?? t}>{t}<small>{TOOL_INFO[t] ?? ''}</small></span>)}</div>
            </div>
          ))}
        </div>
      )}
      {tab === 'history' && (
        connection !== 'live' ? <p className="muted">기록은 내 컴퓨터에 있어요. 보려면 Claude Code와 함께 사무실을 실행하세요.</p>
          : !history ? <p className="muted">불러오는 중…</p>
            : !missions.length ? <p className="muted">아직 기록이 없어요.</p>
              : (
                <div className="hist-team">
                  {missions.map(([id, m]) => (
                    <section key={id}>
                      <h4>{m.title} <span className="count">{fmtDate(m.at)}</span></h4>
                      {m.entries.map((e) => (
                        <div key={e.id} className={`hist-row ${e.status}`} style={{ ['--c' as string]: ROLES[e.role].color }}>
                          <button onClick={() => setOpen(open === e.id ? null : e.id)}>
                            <Avatar role={e.role} size={22} />
                            <b>{e.name}</b>
                            <span>{ROLES[e.role].label} · {e.task}</span>
                            <em>{e.status === 'done' ? '✓' : e.status === 'failed' ? '✕' : '…'} {e.ms ? fmtDuration(e.ms) : ''}</em>
                          </button>
                          {open === e.id && e.report && <div className="md small" dangerouslySetInnerHTML={{ __html: mdToHtml(tidy(e.report)) }} />}
                        </div>
                      ))}
                    </section>
                  ))}
                </div>
              )
      )}
    </Shell>
  );
}

// ── 프린터: 미션 결과물 ──
function FilesRoom() {
  const files = useOffice((s) => s.files);
  const mission = useOffice((s) => s.mission);
  const send = useOffice((s) => s.send);
  const replaying = useOffice((s) => s.replaying);
  if (!mission || !files.length) {
    return <Shell title="결과물" sub="사무실 프린터"><p className="muted">아직 출력된 게 없어요. 팀이 만든 파일이 여기로 와요.</p></Shell>;
  }
  return (
    <Shell title="결과물" sub={`파일 ${plural(files.length, '개')} · ${mission.title}`}>
      <FileActions files={files} missionId={mission.id} disabled={replaying} send={send} />
    </Shell>
  );
}

export function FileActions({ files, missionId, disabled, send }: { files: ReturnType<typeof useOffice.getState>['files']; missionId: string; disabled: boolean; send: ReturnType<typeof useOffice.getState>['send'] }) {
  const agents = useOffice((s) => s.agents);
  return (
    <div className="files">
      {files.map((f) => (
        <div key={f.path} className="file">
          <span className="file-icon">{fileIcon(f.ext)}</span>
          <div className="file-id">
            <b title={f.path}>{f.name}</b>
            <span className="small muted">{fmtSize(f.size)} · {f.by === 'chef' ? '맥스' : agents[f.by]?.name ?? '팀'}</span>
          </div>
          {!disabled && (f.ext === 'html' || f.ext === 'htm') && (
            <button className="btn small primary" onClick={() => { sfx('open'); useOffice.setState({ modal: { kind: 'preview', missionId, file: f.path } }); }}>사이트 보기</button>
          )}
          {!disabled && readable(f.ext) && (
            <button className="btn small" onClick={() => { sfx('open'); useOffice.setState({ modal: null, viewer: { missionId, file: f.path } }); send({ t: 'read', missionId, file: f.path }); send({ t: 'versions', missionId, file: f.path }); }}>읽기</button>
          )}
          {!disabled && <button className="btn small ghost" onClick={() => send({ t: 'open', missionId, file: f.path })}>열기</button>}
        </div>
      ))}
    </div>
  );
}

// ── 팀이 만든 사이트 미리보기 화면(샌드박스: 아무것도 건드릴 수 없다) ──
function PreviewRoom({ missionId, file }: { missionId: string; file: string }) {
  const [device, setDevice] = useState<'desktop' | 'phone'>('desktop');
  const [nonce, setNonce] = useState(0);
  const send = useOffice((s) => s.send);
  const src = `/apercu/${encodeURIComponent(missionId)}/${file.split('/').map(encodeURIComponent).join('/')}`;
  const close = () => useOffice.setState({ modal: null });
  return (
    <div className="modal-back" onClick={close}>
      <div className="monitor" onClick={(e) => e.stopPropagation()}>
        <div className="monitor-bar">
          <span className="dots"><i /><i /><i /></span>
          <span className="addr">🔒 {file}</span>
          <div className="seg small">
            <button className={device === 'desktop' ? 'on' : ''} onClick={() => setDevice('desktop')}>💻 컴퓨터</button>
            <button className={device === 'phone' ? 'on' : ''} onClick={() => setDevice('phone')}>📱 휴대폰</button>
          </div>
          <button className="btn small" onClick={() => setNonce((n) => n + 1)} title="새로고침">↻</button>
          <button className="btn small" title="페이지 코드와 버전 기록" onClick={() => { useOffice.setState({ modal: null, viewer: { missionId, file } }); send({ t: 'read', missionId, file }); send({ t: 'versions', missionId, file }); }}>&lt;/&gt; 코드와 버전</button>
          <button className="btn small" onClick={() => send({ t: 'open', missionId, file })}>브라우저에서 열기</button>
          <button className="close" onClick={close} aria-label="닫기">×</button>
        </div>
        <div className={`monitor-screen ${device}`}>
          <iframe key={nonce} title={file} src={src} sandbox="allow-scripts allow-forms allow-popups allow-modals" referrerPolicy="no-referrer" />
        </div>
      </div>
    </div>
  );
}
