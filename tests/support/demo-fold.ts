// 데모 미션의 모든 이벤트를 클라이언트 스토어(src/state/store.ts)에 적용하고, 이벤트에서 나온 상태만 돌려준다.
// 스토어는 브라우저용 모듈을 끌어오고(오디오), zzfx가 불러오자마자 AudioContext를 만든다: 빈 껍데기 하나만 꽂아 주면 Node에서 돈다.
// 경로를 변수로 불러와서, 서버·테스트용 tsc가 브라우저 코드를 따라가지 않는다(스토어는 루트 tsconfig가 검사한다).
import { readFileSync } from 'node:fs';
import type { Logged, MissionInfo } from '../../shared/protocol.ts';

interface Store {
  getState(): Record<string, unknown> & {
    resetMission(m: MissionInfo | null): void;
    apply(ev: Logged['ev'], at: number, live: boolean): void;
  };
  setState(patch: Record<string, unknown>): void;
}

/** 이벤트에서 나오는 상태. */
export const FOLDED_KEYS = [
  'mission', 'chef', 'agents', 'order', 'plan', 'planHistory', 'files', 'asks', 'stats', 'feed', 'final',
  'busySince', 'workMs', 'showFinal', 'toasts',
] as const;

/** 이벤트와 상관없는 것: 서버가 알려 주는 값, 화면 설정, 열린 창. 스토어에 키가 늘면 둘 중 하나로 분류해야 한다. */
export const UI_KEYS = [
  'connection', 'claude', 'dir', 'settings', 'quota', 'missions', 'replaying', 'viewer', 'modal', 'versions', 'teamHistory',
  'music', 'voiceOn', 'cameraAuto', 'tour', 'historyOpen', 'settingsOpen', 'vertical', 'portrait', 'filming', 'sound', 'tod', 'draft',
  'send', 'receive', 'apply', 'resetMission', 'toast',
] as const;

export const DEMO_PATH = new URL('../../public/demo/mission.json', import.meta.url);

// 스토어는 프로세스당 하나이고 feed 번호가 이어지므로, 한 번만 접는다
let folded: ReturnType<typeof fold> | null = null;
export const foldDemo = () => (folded ??= fold());

async function fold() {
  (globalThis as { AudioContext?: unknown }).AudioContext ??= class {};
  const storeUrl = new URL('../../src/state/store.ts', import.meta.url).href;
  const { useOffice } = (await import(storeUrl)) as { useOffice: Store };
  const demo = JSON.parse(readFileSync(DEMO_PATH, 'utf8')) as { mission: MissionInfo; log: Logged[] };

  // 다시 보기(playReplay)와 같은 순서. 시각은 기록된 시각 그대로, live=false:
  // 소리, 말풍선 효과음, 지연 타이머가 끼지 않는다(접속 중에 'hello'로 받는 기록과 같은 경로).
  useOffice.setState({ replaying: true });
  const st = useOffice.getState();
  st.resetMission({ ...demo.mission, status: 'working' });
  for (const l of demo.log) useOffice.getState().apply(l.ev, l.at, false);

  const state = useOffice.getState();
  const picked: Record<string, unknown> = {};
  for (const k of FOLDED_KEYS) picked[k] = state[k];
  // JSON을 거치면 함수와 undefined가 빠져서 파일과 같은 모양이 된다
  return { snapshot: JSON.parse(JSON.stringify(picked)) as unknown, keys: Object.keys(state), events: demo.log.length };
}
