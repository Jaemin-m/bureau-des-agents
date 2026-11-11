// 마우스 아래에 뭐가 있을까? 로봇, 고양이, 가구, 칠판, 시계… 가장 앞에 있는 것이 이긴다.
import { ROLES } from '../../shared/activity.ts';
import type { Role } from '../../shared/protocol.ts';
import { textWidth } from './font.ts';
import { furniturePlacement } from './furniture.ts';
import { BOARD, CLOCK, DOOR, FURNITURE, NEON, POSTER, WINDOWS, ZONES } from './layout.ts';
import { SIGN, SIGN_H, signPos } from './room.ts';
import type { World } from './world.ts';

export type Hit =
  | { kind: 'actor'; id: string; label: string }
  | { kind: 'cat'; label: string }
  | { kind: 'object'; id: string; label: string; role?: Role };

function furnitureLabel(id: string, kind: string, role?: Role): string {
  switch (kind) {
    case 'desk': return `${ROLES[role ?? 'renfort'].label} 구역의 책상`;
    case 'chair': return `${ROLES[role ?? 'renfort'].label} 구역의 자리`;
    case 'chefDesk': return '맥스의 책상: 팀이 낸 보고서가 모여요';
    case 'chefChair': return '맥스의 의자';
    case 'rack': return '서버: Claude Code와 내 구독';
    case 'printer': return '프린터: 미션 결과물';
    case 'cooler': return '정수기';
    case 'easel': return '디자인 스튜디오의 이젤';
    case 'plantBig': case 'plantTall': case 'plantSmall': return '화분(간지럼 태우면 좋아해요)';
    case 'sofa': return '소파(고양이가 제일 좋아하는 자리)';
    case 'tableLow': return '낮은 탁자';
    case 'lamp': return '스탠드 조명(클릭하면 꺼져요)';
    case 'shelf': return '기록 보관함: 지난 미션';
    case 'coffee': return '커피 머신';
    case 'bin': return '휴지통';
    case 'jukebox': return '주크박스';
  }
  return id;
}

const placed = FURNITURE.map((f) => {
  const p = furniturePlacement(f);
  return { f, x: p.x, y: p.y, w: p.s.c.width, h: p.s.c.height, sortY: p.sortY };
}).sort((a, b) => b.sortY - a.sortY);

const inRect = (x: number, y: number, r: { x: number; y: number; w: number; h: number }) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;

export function hitAt(world: World, x: number, y: number): Hit | null {
  // 로봇(가장 앞에 있는 것부터)
  const actors = [...world.actors.values()].sort((a, b) => (b.seated && b.seat ? b.seat.y : b.y) - (a.seated && a.seat ? a.seat.y : a.y));
  for (const a of actors) {
    const ay = a.seated && a.seat ? a.seat.y : a.y;
    if (a.alpha > 0.3 && x >= a.x - 7 && x <= a.x + 7 && y >= ay - 21 && y <= ay + 1) {
      return { kind: 'actor', id: a.id, label: a.id === 'chef' ? '팀장 맥스' : `${a.name} · ${ROLES[a.role].label}` };
    }
  }
  if (world.cat.hit(x, y)) return { kind: 'cat', label: '사무실 고양이 픽셀' };
  // 가구
  for (const p of placed) {
    if (!inRect(x, y, { x: p.x + 1, y: p.y + 1, w: p.w - 2, h: p.h - 2 })) continue;
    // 그림의 투명한 픽셀은 치지 않는다: 다음 가구를 본다
    return { kind: 'object', id: p.f.id, label: furnitureLabel(p.f.id, p.f.kind, p.f.role), role: p.f.role };
  }
  // 뒷벽과 바닥
  if (inRect(x, y, { x: BOARD.x - 2, y: BOARD.y - 2, w: BOARD.w + 4, h: BOARD.h + 6 })) return { kind: 'object', id: 'board', label: '칠판: 맥스의 계획' };
  if (inRect(x, y, { x: CLOCK.x - 1, y: CLOCK.y - 1, w: 16, h: 16 })) return { kind: 'object', id: 'clock', label: '시계' };
  if (inRect(x, y, { x: NEON.x, y: NEON.y - 3, w: 26, h: 26 })) return { kind: 'object', id: 'neon', label: 'VibesMoney 네온(클릭하면 색이 바뀌어요)' };
  if (inRect(x, y, POSTER)) return { kind: 'object', id: 'poster', label: '목표 포스터' };
  for (const w of WINDOWS) if (inRect(x, y, { x: w.x - 3, y: w.y - 3, w: w.w + 6, h: w.h + 8 })) return { kind: 'object', id: 'window', label: '창문(낮, 저녁, 밤)' };
  if (inRect(x, y, DOOR)) return { kind: 'object', id: 'door', label: '문: 팀원들이 여기로 들어와요' };
  for (const z of ZONES) {
    const w = textWidth(SIGN[z.role] ?? z.label) + 10;
    const s = signPos(z);
    if (inRect(x, y, { x: s.x, y: s.y, w, h: SIGN_H })) return { kind: 'object', id: `zone:${z.role}`, label: `${ROLES[z.role].label} 구역: 누가 어떤 도구로 일하는지`, role: z.role };
  }
  return null;
}
