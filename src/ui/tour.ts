// 사무실 둘러보기: 맥스가 구역마다 사무실을 소개하고, 브라우저 음성으로 읽는다. 카메라가 따라가고,
// 진행 중인 미션이 없으면 둘러보는 동안 시연용 팀이 자리에 앉는다.
import { LINES, say, stopVoice, type Line } from '../audio/voice.ts';
import { camera, world } from '../engine/instance.ts';
import { useOffice } from '../state/store.ts';

const STEPS: { line: Line; shot: [number, number, number] }[] = [
  { line: 'visite-1', shot: [176, 186, 1.9] },
  { line: 'visite-2', shot: [64, 104, 1.7] },
  { line: 'visite-3', shot: [288, 76, 1.95] },
  { line: 'visite-4', shot: [276, 124, 1.95] },
  { line: 'visite-5', shot: [64, 188, 1.95] },
  { line: 'visite-6', shot: [258, 188, 1.95] },
  { line: 'visite-7', shot: [176, 46, 2.05] },
  { line: 'visite-8', shot: [176, 128, 1] },
];

let run = 0;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function startTour() {
  const id = ++run;
  const st = useOffice.getState();
  useOffice.setState({ modal: null, showFinal: false });
  const demo = !st.busySince;
  if (demo) world.demoTeam(true);
  for (let i = 0; i < STEPS.length; i++) {
    if (run !== id) return;
    const s = STEPS[i];
    camera.shot(s.shot[0], s.shot[1], s.shot[2], 60);
    const text = LINES[s.line];
    useOffice.setState({ tour: { step: i, text } });
    if (i === 0 || i === STEPS.length - 1) world.chef.happyUntil = world.time + 2;
    const t0 = Date.now();
    await say(s.line, true);
    // 음성이 없거나 꺼져 있어도 자막을 읽을 시간은 준다(한글은 글자당 정보가 많아 글자당 시간을 넉넉히)
    const minMs = 900 + text.length * 75;
    const spent = Date.now() - t0;
    if (spent < minMs) await wait(minMs - spent);
    await wait(350);
  }
  if (run !== id) return;
  endTour(demo);
}

function endTour(demo: boolean) {
  useOffice.setState({ tour: null });
  camera.wide(2);
  if (demo) world.demoTeam(false);
}

export function stopTour() {
  if (!useOffice.getState().tour) return;
  run++;
  stopVoice();
  endTour(true);
}
