// 8비트 게임기 느낌의 효과음. ZzFX(아주 작은 사운드 합성 라이브러리)로 그 자리에서 만들어서
// 오디오 파일이 없다. 은은하고, 클릭 한 번(소리 버튼)으로 끌 수 있다.
import { ZZFX, zzfx } from 'zzfx';

type Name = 'blip' | 'spawn' | 'tick' | 'search' | 'paper' | 'print' | 'plan' | 'check' | 'ask' | 'yes' | 'no' | 'send' | 'done' | 'error' | 'click' | 'open' | 'meow' | 'pour' | 'glug';

let muted = false;
export function setMuted(m: boolean) { muted = m; }

ZZFX.volume = 0.32;

// 브라우저는 첫 조작 뒤에야 소리를 허락한다: 첫 클릭 때 오디오를 깨운다.
if (typeof window !== 'undefined') {
  const wake = () => { void ZZFX.audioContext?.resume?.(); };
  window.addEventListener('pointerdown', wake, { once: true });
  window.addEventListener('keydown', wake, { once: true });
}

const notes = (list: [number, number][], vol = 0.28) => {
  for (const [f, d] of list) setTimeout(() => { if (!muted) zzfx(vol, 0, f, 0.01, 0.07, 0.18, 0, 1.2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.8); }, d);
};

export function sfx(name: Name, pitch = 1) {
  if (muted) return;
  try {
    switch (name) {
      case 'blip': zzfx(0.09, 0.02, 760 * pitch, 0, 0.012, 0.02, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.4); break;
      case 'spawn': zzfx(0.32, 0.05, 260, 0.02, 0.1, 0.22, 0, 1.4, 14, 0, 0, 0, 0, 0, 0, 0.1, 0, 0.6); break;
      case 'tick': zzfx(0.06, 0.1, 1500, 0, 0.004, 0.012, 1, 1, 0, 0, 0, 0, 0, 0.2); break;
      case 'search': zzfx(0.08, 0.05, 1100, 0, 0.015, 0.05, 0, 1, 0, 0, 380, 0.02); break;
      case 'paper': zzfx(0.22, 0.05, 620, 0.01, 0.04, 0.16, 1, 1, 0, 0, 310, 0.05); break;
      case 'print': zzfx(0.1, 0.1, 110, 0.02, 0.3, 0.08, 2, 1, 0, 0, 0, 0, 0.06, 0.8); break;
      case 'plan': zzfx(0.12, 0.2, 520, 0.02, 0.12, 0.08, 2, 1.5, 0, 0, 0, 0, 0.04, 0.4); break;
      case 'check': zzfx(0.18, 0.02, 880, 0, 0.03, 0.1, 0, 1, 0, 0, 440, 0.04); break;
      case 'ask': zzfx(0.28, 0, 660, 0, 0.07, 0.12, 0, 1, 0, 0, 220, 0.07); break;
      case 'yes': zzfx(0.24, 0, 520, 0, 0.05, 0.12, 0, 1, 0, 0, 260, 0.05); break;
      case 'no': zzfx(0.24, 0, 300, 0, 0.07, 0.14, 1, 1, -4); break;
      case 'send': zzfx(0.2, 0.05, 380, 0.01, 0.05, 0.1, 0, 1, 9); break;
      case 'click': zzfx(0.08, 0, 1300, 0, 0.004, 0.02, 1); break;
      case 'open': zzfx(0.12, 0, 700, 0, 0.02, 0.06, 0, 1, 6); break;
      case 'error': zzfx(0.24, 0.1, 150, 0.02, 0.18, 0.2, 2, 1, -2); break;
      case 'done': notes([[523, 0], [659, 110], [784, 220], [1047, 360]]); break;
      case 'meow': zzfx(0.22, 0.05, 620, 0.03, 0.14, 0.22, 0, 1.6, 7, -10, 0, 0, 0, 0, 2, 0, 0, 0.7); break;
      case 'pour': zzfx(0.1, 0.3, 300, 0.05, 0.5, 0.25, 4, 1, 0, 0, 0, 0, 0, 0.7); break;
      case 'glug': zzfx(0.16, 0.1, 190, 0.01, 0.04, 0.08, 0, 1, 12, 0, 0, 0, 0.09); break;
    }
  } catch { /* 이 기기에는 오디오가 없다 */ }
}
