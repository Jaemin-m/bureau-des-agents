// 사무실 화면: 상단 바, 픽셀 아트 사무실(오른쪽에 팀 패널), 아래에는 말을 거는 맥스.
// 세로 화면(9:16)은 릴스 촬영용이다.
import { useEffect, useRef, useState } from 'react';
import { jukebox } from './audio/music.ts';
import { sfx } from './audio/sfx.ts';
import { applySound } from './audio/sound.ts';
import { savePref, useOffice, type Tod } from './state/store.ts';
import { AskBar } from './ui/Asks.tsx';
import { Dialog } from './ui/Dialog.tsx';
import { FinalCard, History, SettingsPanel, Toasts, Viewer } from './ui/Modals.tsx';
import { Office } from './ui/Office.tsx';
import { Panel } from './ui/Panel.tsx';
import { Strips } from './ui/Strips.tsx';
import { party } from './ui/interact.ts';
import { Rooms } from './ui/Rooms.tsx';
import { startTour, stopTour } from './ui/tour.ts';
import { TopBar } from './ui/TopBar.tsx';

const KONAMI = ['arrowup', 'arrowup', 'arrowdown', 'arrowdown', 'arrowleft', 'arrowright', 'arrowleft', 'arrowright', 'b', 'a'];

const TOD_NEXT: Record<Tod, Tod> = { auto: 'day', day: 'evening', evening: 'night', night: 'auto' };

/** 촬영 모드에서 나가는 버튼. 마우스를 움직일 때만 보인다(화면을 깔끔하게 유지). */
function ExitFilming() {
  const [shown, setShown] = useState(true);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cameraAuto = useOffice((s) => s.cameraAuto);
  useEffect(() => {
    const wake = () => {
      setShown(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setShown(false), 2500);
    };
    wake();
    window.addEventListener('pointermove', wake);
    return () => { window.removeEventListener('pointermove', wake); if (timer.current) clearTimeout(timer.current); };
  }, []);
  return (
    <div className={`exit-filming ${shown ? 'shown' : ''}`}>
      <button onClick={() => { useOffice.setState({ cameraAuto: !cameraAuto }); savePref('cameraAuto', !cameraAuto); }}>{cameraAuto ? '🎥 자동 카메라: 켜짐' : '🎥 자동 카메라: 꺼짐'}</button>
      <button onClick={() => void startTour()}>🎤 사무실 둘러보기</button>
      <button className="quit" onClick={() => useOffice.setState({ filming: false })}>✕ 촬영 끝내기 (F 또는 Esc)</button>
    </div>
  );
}

export function App() {
  const vertical = useOffice((s) => s.vertical || s.portrait);
  const filming = useOffice((s) => s.filming);

  // 세로로 긴 화면(휴대폰)에서는 세로 레이아웃을 쓴다
  useEffect(() => {
    const onResize = () => useOffice.setState({ portrait: window.innerWidth / Math.max(1, window.innerHeight) < 0.8 });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    let combo: string[] = [];
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const s = useOffice.getState();
      const k = e.key.toLowerCase();
      // 비밀 코드(↑ ↑ ↓ ↓ ← → ← → B A): 저녁 모드
      combo = [...combo, k].slice(-KONAMI.length);
      if (combo.join() === KONAMI.join()) { combo = []; party(); return; }
      if (k === 'escape') {
        if (s.tour) { stopTour(); return; }
        if (s.modal || s.viewer || s.historyOpen || s.settingsOpen || s.showFinal) {
          useOffice.setState({ modal: null, viewer: null, historyOpen: false, settingsOpen: false, showFinal: false });
          return;
        }
        if (s.filming) useOffice.setState({ filming: false });
        return;
      }
      if (k === 't') { if (s.tour) stopTour(); else void startTour(); return; }
      if (k === 'c') { useOffice.setState({ cameraAuto: !s.cameraAuto }); savePref('cameraAuto', !s.cameraAuto); sfx('click'); return; }
      if (k === 'j') { jukebox.toggle(); return; }
      if (k === 'v') { useOffice.setState({ vertical: !s.vertical }); savePref('vertical', !s.vertical); sfx('click'); }
      else if (k === 'f') { useOffice.setState({ filming: !s.filming }); sfx('click'); }
      else if (k === 'n') { const n = TOD_NEXT[s.tod]; useOffice.setState({ tod: n }); savePref('tod', n); sfx('click'); }
      else if (k === 'm') { useOffice.setState({ sound: !s.sound }); savePref('sound', !s.sound); applySound(!s.sound); }
      else if (k === 'h') { useOffice.setState({ historyOpen: !s.historyOpen }); sfx('open'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={`app ${vertical ? 'vertical' : ''} ${filming ? 'filming' : ''}`}>
      <div className="frame">
        <TopBar />
        <div className="main">
          <div className="stage">
            <Office />
            {vertical && <Strips />}
            <AskBar />
            <FinalCard />
          </div>
          {!vertical && !filming && <Panel />}
        </div>
        <Dialog />
      </div>
      {filming && <ExitFilming />}
      <Viewer />
      <Rooms />
      <History />
      <SettingsPanel />
      <Toasts />
    </div>
  );
}
