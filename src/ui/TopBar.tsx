// 상단 바: 사무실 이름, 진행 중인 미션과 경과 시간, 카운터(에이전트,
// 검색, 읽은 페이지, 결과물), 구독 에너지, 화면 설정.
import { useEffect, useState } from 'react';
import { sfx } from '../audio/sfx.ts';
import { applySound } from '../audio/sound.ts';
import { replaySpeed, stopReplay } from '../net/link.ts';
import { savePref, useOffice, type Tod } from '../state/store.ts';
import { fmtClock } from './format.ts';
import { startTour } from './tour.ts';

export function Logo({ size = 26 }: { size?: number }) {
  return (
    <span className="logo" style={{ width: size, height: size }} aria-hidden="true">
      <span className="logo-visor"><i /><i /></span>
    </span>
  );
}

function useTick(on: boolean) {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setN((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [on]);
}

const TOD_NEXT: Record<Tod, Tod> = { auto: 'day', day: 'evening', evening: 'night', night: 'auto' };
const TOD_ICON: Record<Tod, string> = { auto: '🕒', day: '☀️', evening: '🌇', night: '🌙' };
const TOD_LABEL: Record<Tod, string> = { auto: 'Mac 시간대로', day: '낮', evening: '저녁', night: '밤' };

export function TopBar() {
  const mission = useOffice((s) => s.mission);
  const busySince = useOffice((s) => s.busySince);
  const workMs = useOffice((s) => s.workMs);
  const stats = useOffice((s) => s.stats);
  const files = useOffice((s) => s.files.length);
  const plan = useOffice((s) => s.plan);
  const quota = useOffice((s) => s.quota);
  const replaying = useOffice((s) => s.replaying);
  const connection = useOffice((s) => s.connection);
  const final = useOffice((s) => s.final);
  const vertical = useOffice((s) => s.vertical);
  const filming = useOffice((s) => s.filming);
  const sound = useOffice((s) => s.sound);
  const tod = useOffice((s) => s.tod);
  const musicOn = useOffice((s) => s.music.playing);
  useTick(busySince !== null);
  const elapsed = workMs + (busySince ? Date.now() - busySince : 0);
  const done = plan.filter((p) => p.status === 'completed').length;
  const current = plan.find((p) => p.status === 'in_progress') ?? plan.find((p) => p.status === 'pending');

  const status = !mission ? null : busySince ? 'live' : final?.ok ? 'done' : mission.status === 'error' ? 'error' : 'stopped';
  const toggle = (k: 'vertical' | 'filming' | 'sound') => {
    sfx('click');
    const v = !useOffice.getState()[k];
    useOffice.setState({ [k]: v });
    if (k !== 'filming') savePref(k, v);
    if (k === 'sound') applySound(v);
  };

  return (
    <header className="topbar">
      <div className="brand">
        <Logo />
        <div>
          <b>에이전트 사무실</b>
          <span>{connection === 'demo' ? '데모 · VibesMoney' : 'VibesMoney 제작'}</span>
        </div>
      </div>

      <div className="mission-head">
        {mission ? (
          <>
            <span className={`dot ${status}`} />
            <span className="mission-title" title={mission.prompt}>{mission.title}</span>
            <span className="timer">{fmtClock(elapsed)}</span>
          </>
        ) : <span className="muted">진행 중인 미션 없음</span>}
        {mission && plan.length > 0 && (
          <span className="plan-step" title={current?.text ?? ''}>📋 {done}/{plan.length}{current && busySince ? ` · ${current.text}` : ''}</span>
        )}
      </div>

      {mission && (
        <div className="stats">
          <span title="부른 에이전트">🤖 {stats.agents}</span>
          <span title="인터넷 검색">🔎 {stats.searches}</span>
          <span title="읽은 웹 페이지">🌐 {stats.pages}</span>
          <span title="만든 파일">📄 {files}</span>
        </div>
      )}

      {replaying && (
        <div className="replay-bar">
          <span>다시 재생 중</span>
          {[1, 2, 4].map((x) => <button key={x} onClick={() => replaySpeed(x)}>×{x}</button>)}
          {connection !== 'demo' && <button onClick={() => { sfx('click'); stopReplay(); }}>나가기</button>}
        </div>
      )}

      <div className="tools">
        {quota && (
          <span className="energy" title={`5시간 구독 사용량: ${Math.round(quota.fiveHour * 100)}% 사용`}>
            <span className="energy-label">에너지</span>
            <span className="energy-bar"><i style={{ width: `${Math.max(3, 100 - quota.fiveHour * 100)}%` }} /></span>
          </span>
        )}
        <button className="icon-btn" title="사무실 둘러보기: 맥스가 사무실을 소개해요 (T)" onClick={() => void startTour()}>🎤</button>
        <button className="icon-btn" title="팀 전체: 직무, 도구, 기록" onClick={() => { sfx('open'); useOffice.setState({ modal: { kind: 'team' } }); }}>👥</button>
        <button className={`icon-btn ${musicOn ? 'on' : ''}`} title="주크박스 (J)" onClick={() => { sfx('open'); useOffice.setState({ modal: { kind: 'jukebox' } }); }}>{musicOn ? '🎶' : '🎵'}</button>
        <button className="icon-btn" title="지난 미션 (H)" onClick={() => { sfx('open'); useOffice.setState({ historyOpen: true }); }}>🗂️</button>
        <button className="icon-btn" title={`사무실 시간: ${TOD_LABEL[tod]} (N)`} onClick={() => { sfx('click'); const n = TOD_NEXT[tod]; useOffice.setState({ tod: n }); savePref('tod', n); }}>{TOD_ICON[tod]}</button>
        <button className="icon-btn" title={sound ? '소리 끄기 (M)' : '소리 켜기 (M)'} onClick={() => toggle('sound')}>{sound ? '🔊' : '🔇'}</button>
        <button className={`icon-btn ${vertical ? 'on' : ''}`} title="9:16 세로 화면, 릴스 촬영용 (V)" onClick={() => toggle('vertical')}>📱</button>
        <button className={`icon-btn ${filming ? 'on' : ''}`} title="촬영 모드: 사무실과 맥스만 보여요 (F)" onClick={() => toggle('filming')}>🎬</button>
        <button className="icon-btn" title="설정" onClick={() => { sfx('open'); useOffice.setState({ settingsOpen: true }); }}>⚙️</button>
      </div>
    </header>
  );
}
