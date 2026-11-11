// 화면에는 전체 경로를 절대 보여 주지 않는다(영상에 사용자 이름이 나올 수 있다):
// 미션 폴더는 “미션 폴더”로, 나머지는 “…/파일”로 바꾼다.
import { useOffice } from '../state/store.ts';

export function tidy(text: string): string {
  if (!text) return text;
  const s = useOffice.getState();
  let t = text;
  const folder = s.mission?.folder;
  if (folder) t = t.split(folder + '/').join('').split(folder).join('미션 폴더');
  if (s.dir) t = t.split(s.dir).join('에이전트 사무실');
  return t.replace(/(?:\/private)?\/(?:Users|home|tmp|var)\/[^\s"'`)»”]*\/([^/\s"'`)»”]+)/g, '…/$1');
}
