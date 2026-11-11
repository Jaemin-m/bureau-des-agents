// 사무실 주크박스: 사무실을 위해 ElevenLabs Music과 Google Lyria로 만든 오리지널 곡 여섯 개
// (프로그레시브 하우스, 멜로딕 테크노). 리듬(저음)도 들어서 조명을 깜빡이고 로봇을 춤추게 한다.
import { useOffice } from '../state/store.ts';

export interface Track { id: string; title: string; mood: string; by: string; file: string }

export const TRACKS: Track[] = [
  { id: 'coucher-de-soleil', title: '노을', mood: '멜로딕 프로그레시브 하우스', by: 'ElevenLabs', file: '/music/coucher-de-soleil.mp3' },
  { id: 'nuit-au-bureau', title: '사무실의 밤', mood: '멜로딕 테크노', by: 'ElevenLabs', file: '/music/nuit-au-bureau.mp3' },
  { id: 'afterwork', title: '퇴근 후', mood: '햇살 같은 프로그레시브 하우스', by: 'ElevenLabs', file: '/music/afterwork.mp3' },
  { id: 'golden-hour', title: '골든 아워', mood: '프로그레시브 하우스', by: 'Lyria', file: '/music/golden-hour.mp3' },
  { id: 'minuit-pile', title: '자정 정각', mood: '멜로딕 테크노', by: 'Lyria', file: '/music/minuit-pile.mp3' },
  { id: 'vendredi-18h', title: '금요일 오후 6시', mood: '햇살 같은 하우스', by: 'Lyria', file: '/music/vendredi-18h.mp3' },
];

class Jukebox {
  private audio: HTMLAudioElement | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private gain: GainNode | null = null;
  private bins: Uint8Array<ArrayBuffer> | null = null;
  private ducked = false;
  private muted = false;
  index = 0;
  playing = false;
  volume = 0.55;
  /** 부드럽게 다듬은 저음 세기(0~1) */
  level = 0;
  /** 방금 킥 드럼이 울렸다 */
  beat = false;
  private lastPeak = 0;
  private avg = 0;

  private ensure() {
    if (this.audio) return;
    const a = new Audio();
    a.preload = 'auto';
    a.addEventListener('ended', () => this.next());
    this.audio = a;
    try {
      const ctx = new AudioContext();
      const src = ctx.createMediaElementSource(a);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.6;
      const gain = ctx.createGain();
      src.connect(analyser);
      analyser.connect(gain);
      gain.connect(ctx.destination);
      this.ctx = ctx;
      this.analyser = analyser;
      this.gain = gain;
      this.bins = new Uint8Array(analyser.frequencyBinCount);
    } catch { /* 분석이 안 돼도 음악은 나온다 */ }
    this.applyVolume();
  }

  private applyVolume() {
    const v = this.muted ? 0 : this.volume * (this.ducked ? 0.35 : 1);
    if (this.gain && this.ctx) this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.12);
    else if (this.audio) this.audio.volume = v;
  }

  private publish() {
    useOffice.setState({ music: { playing: this.playing, index: this.index, volume: this.volume } });
  }

  play(index = this.index) {
    this.ensure();
    const a = this.audio!;
    if (index !== this.index || !a.src) {
      this.index = (index + TRACKS.length) % TRACKS.length;
      a.src = TRACKS[this.index].file;
    }
    void this.ctx?.resume();
    void a.play().then(() => { this.playing = true; this.publish(); }).catch(() => { this.playing = false; this.publish(); });
    this.playing = true;
    this.publish();
  }

  pause() {
    this.audio?.pause();
    this.playing = false;
    this.level = 0;
    this.publish();
  }

  toggle() { if (this.playing) this.pause(); else this.play(); }
  next() { this.play(this.index + 1); }
  prev() { this.play(this.index - 1); }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    this.applyVolume();
    this.publish();
  }

  /** 맥스가 말할 때는 음악 소리를 줄인다. */
  duck(on: boolean) { this.ducked = on; this.applyVolume(); }
  setMuted(m: boolean) { this.muted = m; this.applyVolume(); }

  /** 매 프레임: 저음 세기(조명과 춤에 쓴다). */
  sample() {
    this.beat = false;
    if (!this.playing || !this.analyser || !this.bins) { this.level *= 0.9; return this.level; }
    this.analyser.getByteFrequencyData(this.bins);
    let sum = 0;
    for (let i = 1; i < 7; i++) sum += this.bins[i];
    const bass = sum / (6 * 255);
    this.avg = this.avg * 0.92 + bass * 0.08;
    const now = performance.now();
    if (bass > this.avg * 1.18 && bass > 0.45 && now - this.lastPeak > 260) { this.beat = true; this.lastPeak = now; }
    this.level = this.level * 0.6 + bass * 0.4;
    return this.level;
  }
}

export const jukebox = new Jukebox();
