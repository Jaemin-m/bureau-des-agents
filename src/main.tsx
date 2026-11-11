import { createRoot } from 'react-dom/client';
import '@fontsource/pixelify-sans/500.css';
import '@fontsource/pixelify-sans/700.css';
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import './fonts.css';
import './styles.css';
import { App } from './App.tsx';
import { applySound } from './audio/sound.ts';
import { camera, world } from './engine/instance.ts';
import { jukebox } from './audio/music.ts';
import { party } from './ui/interact.ts';
import { startTour } from './ui/tour.ts';
import { perf } from './ui/Office.tsx';
import { connect, playReplay } from './net/link.ts';
import { useOffice } from './state/store.ts';
import { HANGUL_FONT } from './engine/font.ts';

applySound(useOffice.getState().sound);
// 테스트와 녹화용: 콘솔에서 미션을 다시 재생한다
(window as unknown as { __bureau: unknown }).__bureau = { playReplay, useOffice, world, perf, camera, jukebox, party, startTour };
connect();
// 캔버스 간판의 한글은 글꼴을 픽셀로 옮겨 그리므로, 글꼴을 먼저 불러온 뒤 화면을 띄운다(실패해도 띄운다)
const render = () => createRoot(document.getElementById('root')!).render(<App />);
document.fonts.load(HANGUL_FONT, '가').then(render, render);
