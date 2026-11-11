// 브리지(Claude Code를 조종하는 로컬 서버)와의 연결. 브리지가 없으면(공개 사이트, 휴대폰)
// 사무실은 데모 모드가 되어 녹화한 실제 미션을 다시 재생한다.
import type { ClientMsg, Logged, MissionInfo, ServerMsg } from '../../shared/protocol.ts';
import { useOffice } from '../state/store.ts';

let ws: WebSocket | null = null;
let everConnected = false;
let retry = 0;
let player: { stop: () => void } | null = null;
let lastReplay: { mission: MissionInfo; log: Logged[] } | null = null;
let build = '';

export function sendToBridge(m: ClientMsg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  else useOffice.getState().toast('error', '사무실이 Claude Code와 연결되지 않았어요. 사무실 폴더에서 “npm start”를 실행해 주세요.');
}

export function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}/ws`);
  ws = socket;
  const failTimer = setTimeout(() => { if (!everConnected) socket.close(); }, 2500);
  socket.onopen = () => {
    clearTimeout(failTimer);
    everConnected = true;
    retry = 0;
    useOffice.setState({ connection: 'live', send: sendToBridge });
  };
  socket.onmessage = (e) => {
    let m: ServerMsg;
    try { m = JSON.parse(String(e.data)); } catch { return; }
    if (m.t === 'replay') { playReplay(m.mission, m.log, 1); return; }
    if (m.t === 'hello' && m.build && m.build !== 'dev') {
      // 탭을 연 뒤 사무실이 업데이트됐다: 페이지를 다시 불러온다
      if (build && build !== m.build) { location.reload(); return; }
      build = m.build;
    }
    useOffice.getState().receive(m);
  };
  socket.onclose = () => {
    clearTimeout(failTimer);
    if (!everConnected) {
      useOffice.setState({ connection: 'offline' });
      void startDemo();
      return;
    }
    useOffice.setState({ connection: 'connecting' });
    setTimeout(connect, Math.min(8000, 600 * 2 ** retry++));
  };
}

/**
 * 녹화한 미션을 원래 속도로 다시 재생한다(긴 공백은 줄인다).
 * 촬영할 때 편하다: 팀을 다시 돌리지 않고 같은 미션을 몇 번이고 볼 수 있다.
 */
export function playReplay(mission: MissionInfo, log: Logged[], speed = 1, opts: { loop?: boolean; onEnd?: () => void } = {}) {
  player?.stop();
  lastReplay = { mission, log };
  const st = useOffice.getState();
  useOffice.setState({ replaying: true });
  st.resetMission({ ...mission, status: 'working' });
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const start = Date.now();
  let i = 0;
  let virt = 0;
  const step = () => {
    if (cancelled) return;
    if (i >= log.length) {
      if (opts.loop) { timer = setTimeout(() => { if (!cancelled) playReplay(mission, log, speed, opts); }, 9000); }
      opts.onEnd?.();
      return;
    }
    const l = log[i++];
    useOffice.getState().apply(l.ev, start + virt, true);
    if (i < log.length) {
      // 두 이벤트 사이의 실제 간격을 빠르게 하되 최대 2.5초까지만 기다린다
      const gap = Math.min(2500, Math.max(0, log[i].at - l.at) / speed);
      virt += gap;
      timer = setTimeout(step, gap);
    } else step();
  };
  timer = setTimeout(step, 600);
  player = { stop: () => { cancelled = true; if (timer) clearTimeout(timer); } };
  return player;
}

/** 다시 보기를 처음부터 다른 속도로 재생한다. */
export function replaySpeed(speed: number) {
  if (!lastReplay) return;
  playReplay(lastReplay.mission, lastReplay.log, speed, { loop: useOffice.getState().connection === 'demo' });
}

/** 다시 보기를 멈추고 실시간 사무실로 돌아간다. */
export function stopReplay() {
  player?.stop();
  player = null;
  useOffice.setState({ replaying: false });
  if (ws?.readyState === WebSocket.OPEN) {
    // 사무실 상태를 다시 받는다: 다시 연결하는 게 가장 간단하다
    ws.close();
  } else useOffice.getState().resetMission(null);
}

/** 브리지가 없을 때: 데모가 녹화한 실제 미션을 반복 재생한다. */
async function startDemo() {
  try {
    const res = await fetch('/demo/mission.json');
    if (!res.ok) return;
    const data = (await res.json()) as { mission: MissionInfo; log: Logged[] };
    useOffice.setState({
      connection: 'demo',
      send: () => useOffice.getState().toast('info', '데모 화면이에요. 에이전트 사무실을 설치하면 내 팀을 직접 움직일 수 있어요.'),
    });
    playReplay(data.mission, data.log, 1, { loop: true });
  } catch { /* 데모가 없다 */ }
}
