// 로봇이 뭔가 할 때 머리 위로 떠오르는 작은 아이콘
// (검색은 돋보기, 웹 페이지는 지구본, 파일은 종이…).
import type { ActKind } from '../../shared/protocol.ts';
import { fromRows, outline, P } from './pixels.ts';

const pal: Record<string, string> = {
  w: '#ffffff', g: '#cfd2e0', d: '#5d6178', o: P.orange, O: P.orangeLight, b: '#4fb3ff', B: '#9fe0ff', n: '#3ddc97',
  y: '#ffd166', p: '#ff6fa8', v: '#a98bff', k: '#2b2836', r: '#ff6b5e', c: '#8a5530',
};

const ROWS: Record<string, string[]> = {
  search: [
    '.ggg...',
    'gBBBg..',
    'gBwBg..',
    'gBBBg..',
    '.ggdd..',
    '....dd.',
    '.....dd',
  ],
  web: [
    '..bbb..',
    '.bnbbb.',
    'bnnbbnb',
    'bbnbnnb',
    'bbbbnbb',
    '.bbnbb.',
    '..bbb..',
  ],
  read: [
    'wwg.gww',
    'wgg.ggw',
    'wwg.gww',
    'wgg.ggw',
    'wwg.gww',
    'dddkddd',
    '.......',
  ],
  write: [
    'wwwww.o',
    'wggg.oO',
    'wwww.o.',
    'wgg.o..',
    'www.k..',
    'wggggg.',
    'wwwwww.',
  ],
  bash: [
    'kkkkkkk',
    'knkkkkk',
    'kknkkkk',
    'knkknnk',
    'kkkkkkk',
    'kkkkkkk',
    '.......',
  ],
  plan: [
    '.ddkdd.',
    'dwwwwwd',
    'dwnwggd',
    'dwwwwwd',
    'dwnwggd',
    'dwwwwwd',
    'ddddddd',
  ],
  skill: [
    '...y...',
    '..yyy..',
    'yyyyyyy',
    '.yyyyy.',
    '.yy.yy.',
    'y.....y',
    '.......',
  ],
  mcp: [
    '.v...v.',
    '.v...v.',
    'vvvvvvv',
    'vvvvvvv',
    '.vvvvv.',
    '...v...',
    '...v...',
  ],
  check: [
    '......n',
    '.....nn',
    'n...nn.',
    'nn.nn..',
    '.nnn...',
    '..n....',
    '.......',
  ],
  alert: [
    '..ooo..',
    '..ooo..',
    '..ooo..',
    '..ooo..',
    '.......',
    '..ooo..',
    '..ooo..',
  ],
  paper: [
    'wwwww..',
    'wgggww.',
    'wwwwwww',
    'wggggw.',
    'wwwwww.',
    'wgggww.',
    'wwwwww.',
  ],
  heart: [
    '.rr.rr.',
    'rrrrrrr',
    'rrrrrrr',
    '.rrrrr.',
    '..rrr..',
    '...r...',
    '.......',
  ],
  note: [
    '...oo..',
    '...ooO.',
    '...o.oO',
    '...o...',
    '.ooo...',
    'oooo...',
    '.oo....',
  ],
  note2: [
    '..ppppp',
    '..p...p',
    '..p...p',
    '..p...p',
    'ppp.ppp',
    'ppp.ppp',
    '.......',
  ],
  zzz: [
    'wwww...',
    '..w....',
    '.w.....',
    'wwww...',
    '....www',
    '.....w.',
    '....www',
  ],
  coffee: [
    '.g..g..',
    '..g..g.',
    'wwwww..',
    'wcccwww',
    'wcccw.w',
    'wwwwwww',
    '.www...',
  ],
  drop: [
    '...b...',
    '..bbb..',
    '.bbBbb.',
    '.bBbbb.',
    'bbbbbbb',
    '.bbbbb.',
    '..bbb..',
  ],
  idea: [
    '..yyy..',
    '.yyOyy.',
    '.yyyyy.',
    '.yyyyy.',
    '..yyy..',
    '..ddd..',
    '...d...',
  ],
};

const cache = new Map<string, HTMLCanvasElement>();

export type IconName = keyof typeof ROWS;

export function icon(name: IconName): HTMLCanvasElement {
  let c = cache.get(name);
  if (!c) {
    const src = fromRows(ROWS[name], pal);
    // 윤곽선을 위한 1픽셀 여백
    const m = document.createElement('canvas');
    m.width = src.width + 2;
    m.height = src.height + 2;
    const g = m.getContext('2d')!;
    g.drawImage(src, 1, 1);
    outline(m, P.ink, { diagonal: false });
    c = m;
    cache.set(name, c);
  }
  return c;
}

export function iconFor(kind: ActKind): IconName {
  switch (kind) {
    case 'search': return 'search';
    case 'web': return 'web';
    case 'read': return 'read';
    case 'write': return 'write';
    case 'edit': return 'write';
    case 'bash': return 'bash';
    case 'plan': return 'plan';
    case 'skill': return 'skill';
    case 'mcp': return 'mcp';
    default: return 'idea';
  }
}
