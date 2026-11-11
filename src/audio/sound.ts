// 소리 버튼은 전부 끈다: 효과음, 주크박스 음악, 맥스의 목소리.
import { useOffice } from '../state/store.ts';
import { jukebox } from './music.ts';
import { setMuted } from './sfx.ts';
import { setVoice } from './voice.ts';

export function applySound(on: boolean) {
  setMuted(!on);
  jukebox.setMuted(!on);
  setVoice(on && useOffice.getState().voiceOn);
}
