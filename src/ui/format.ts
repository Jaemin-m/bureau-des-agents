// 화면에 보여 줄 작은 표기 형식들(한국어).
export const fmtDuration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}분 ${s % 60}초` : `${m}분`;
  return m % 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${Math.floor(m / 60)}시간`;
};

export const fmtClock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export const fmtDate = (t: number) => new Date(t).toLocaleString('ko-KR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** 개수와 단위. 한국어는 단·복수가 같다: `plural(3, '개')` → "3개" */
export const plural = (n: number, unit: string) => `${n}${unit}`;

export const fileIcon = (ext: string) =>
  ext === 'html' || ext === 'htm' ? '🌐' : ext === 'md' || ext === 'txt' ? '📄' : ext === 'csv' || ext === 'xlsx' ? '📊' : ['png', 'jpg', 'jpeg', 'svg', 'gif', 'webp'].includes(ext) ? '🖼️' : ext === 'pdf' ? '📕' : ['js', 'ts', 'py', 'json', 'css'].includes(ext) ? '💻' : '📁';

/** 사무실 안에서 바로 읽을 수 있는 파일. */
export const readable = (ext: string) => ['md', 'txt', 'csv', 'json', 'markdown'].includes(ext);

/** 화면에 보여도 되는 경로: 홈 폴더는 “~”로 바꾼다(영상에 사용자 이름이 나오지 않게). */
export const tilde = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+/, '~');
