// 맥스의 목소리: 브라우저 음성 합성(Web Speech API, ko-KR)으로 대사를 읽는다. 사무실 둘러보기와
// 미션 중 몇 마디에 쓴다. 맥스가 말하는 동안 음악 소리를 줄인다. 브라우저·OS에 한국어 음성이 없으면 자막만 남는다.
import { jukebox } from './music.ts';

export type Line =
  | 'parti' | 'equipe' | 'accomplie' | 'feu-vert' | 'afterwork'
  | 'visite-1' | 'visite-2' | 'visite-3' | 'visite-4' | 'visite-5' | 'visite-6' | 'visite-7' | 'visite-8';

/** 맥스의 대사. 둘러보기(visite-*) 문구는 화면 자막으로도 쓴다. */
export const LINES: Record<Line, string> = {
  parti: '자, 시작해요!',
  equipe: '팀을 꾸릴게요.',
  accomplie: '미션 완료!',
  'feu-vert': '잠깐, 허락이 필요해요.',
  afterwork: '오늘 일은 끝! 퇴근하고 한잔해요.',
  'visite-1': '제 사무실에 온 걸 환영해요! 저는 팀장 맥스예요. 여기선 AI 에이전트 팀이 밤낮없이 일해요.',
  'visite-2': '여기는 리서치 팀이에요. 리서처들이 인터넷을 뒤져요. 가격, 경쟁사, 고객 후기까지요.',
  'visite-3': '여기는 코드 작업실이에요. 사이트, 도구, 자동화를 만들어요.',
  'visite-4': '디자인 스튜디오예요. 예뻐야 하는 건 전부 여기를 거쳐요.',
  'visite-5': '글쓰기 팀이에요. 게시물, 메일, 영상 대본을 써요.',
  'visite-6': '그리고 분석 팀. 숫자, 표, 그리고 중요한 결론을 맡아요.',
  'visite-7': '이 화이트보드에 미션마다 계획을 써요. 그리고 모든 보고서는 제 책상으로 와요.',
  'visite-8': '원하는 걸 말해 주세요. 제가 팀을 꾸릴게요. 그다음엔 지켜보기만 하면 돼요.',
};

const synth: SpeechSynthesis | null = typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;

let enabled = true;
let current: SpeechSynthesisUtterance | null = null;
let lastAt = 0;

/** 고른 한국어 음성. undefined는 아직 안 골랐다는 뜻, null은 한국어 음성이 없다는 뜻. */
let voice: SpeechSynthesisVoice | null | undefined;

// 맥스는 남자 팀장이라 남성 음성을 먼저 찾고, 없으면 아무 한국어 음성이나 쓴다.
// Eddy·Reed: macOS, InJoon: Windows/Edge.
const MALE = /eddy|reed|injoon|minsu|jinho|male/i;

function pickVoice(): SpeechSynthesisVoice | null {
  if (!synth) return null;
  const ko = synth.getVoices().filter((v) => v.lang.replace('_', '-').toLowerCase().startsWith('ko'));
  return ko.find((v) => MALE.test(v.name)) ?? ko.find((v) => v.localService) ?? ko[0] ?? null;
}

// 음성 목록은 페이지가 열린 뒤 늦게 채워지는 브라우저가 많다
synth?.addEventListener('voiceschanged', () => { voice = pickVoice(); });

export function setVoice(on: boolean) {
  enabled = on;
  if (!on) stopVoice();
}

export function stopVoice() {
  if (current) {
    current = null;
    synth?.cancel();
  }
  jukebox.duck(false);
}

/**
 * 맥스에게 대사를 시킨다. 대사가 끝나면 풀리는 프로미스를 돌려준다(음성이 꺼졌거나 없으면 바로 풀린다).
 * `force`: 둘러보기는 다른 대사 바로 뒤에도 말한다.
 */
export function say(line: Line, force = false): Promise<void> {
  if (!enabled || !synth) return Promise.resolve();
  const now = performance.now();
  if (!force && now - lastAt < 2500) return Promise.resolve();
  lastAt = now;
  stopVoice();
  if (!voice) voice = pickVoice();
  if (!voice) return Promise.resolve();
  const text = LINES[line];
  const u = new SpeechSynthesisUtterance(text);
  u.voice = voice;
  u.lang = voice.lang;
  u.rate = 1.05;
  u.volume = 0.95;
  current = u;
  jukebox.duck(true);
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      if (current === u) { current = null; jukebox.duck(false); }
      resolve();
    };
    u.onend = done;
    u.onerror = done;
    // end 이벤트를 빠뜨리는 브라우저가 있어서, 글자 수로 넉넉히 잡은 시간이 지나면 끝난 것으로 본다
    const guard = setTimeout(done, 3000 + text.length * 200);
    synth.speak(u);
  });
}
