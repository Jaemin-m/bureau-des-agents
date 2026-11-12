// 사무실의 직무, 그리고 각 에이전트가 실제로 하는 일을 한국어로 옮긴 것.
// Claude Code의 도구 하나하나가 행동(아이콘, 애니메이션, 말풍선)이 된다.
import type { ActKind, MissionStats, OfficeEvent, Role } from './protocol.ts';

export interface RoleInfo {
  /** 사무실에 표시되는 직무 이름 */
  label: string;
  icon: string;
  color: string;
  /** hire 이벤트의 type. 옛 기록(Claude Code 서브에이전트)의 subagent_type과 같은 이름이다 */
  type: string;
  what: string;
}

export const ROLES: Record<Role, RoleInfo> = {
  chef: { label: '팀장', icon: '⭐', color: '#FF8A3D', type: '', what: '요청을 받아 계획을 세우고, 일을 나누고, 결과물을 하나로 모아요.' },
  recherche: { label: '리서치', icon: '🔎', color: '#4FB3FF', type: 'chercheur', what: '인터넷에서 찾아요. 경쟁사, 가격, 리뷰, 뉴스, 출처.' },
  code: { label: '코드', icon: '💻', color: '#3DDC97', type: 'developpeur', what: '코드, 웹사이트, 스크립트, 자동화. 실행하고 테스트하는 모든 것.' },
  design: { label: '디자인', icon: '🎨', color: '#FF6FA8', type: 'designer', what: '완성도 높은 웹 페이지, 시안, 비주얼, 꾸미기.' },
  redaction: { label: '글쓰기', icon: '✍️', color: '#A98BFF', type: 'redacteur', what: 'SNS 글, 이메일, 기사, 영상 대본, 보고서.' },
  analyse: { label: '분석', icon: '📊', color: '#FFC93D', type: 'analyste', what: '숫자, 표, 파일, 비교, 계산.' },
  renfort: { label: '지원', icon: '🤖', color: '#9AA3B5', type: '', what: '따로 떨어진 일을 거들어요.' },
};

/** 직무가 할 수 있는 일. CLI마다 이것을 자기 도구나 샌드박스로 옮긴다. */
export type Power = 'read' | 'write' | 'search' | 'fetch' | 'run';

/** 쓰기 권한(access 'write')이 있어야 하는 힘. 읽기 전용 일에서는 빠지고, 묻지 않고 쓰는 목록에도 들지 않는다. */
export const MUTATING_POWERS: readonly Power[] = ['write', 'run'];

/**
 * 직무별 힘. 직무 카드의 도구 목록과 CLI별 도구 목록은 모두 여기서 나온다.
 * 맥스는 읽기만 한다. 일은 사무실 MCP(office_plan)로 일꾼에게 맡기고, 쓰기, 명령, 검색은 일꾼의 몫이다.
 */
export const ROLE_POWERS: Record<Role, readonly Power[]> = {
  chef: ['read'],
  recherche: ['read', 'search', 'fetch'],
  code: ['read', 'write', 'fetch', 'run'],
  design: ['read', 'write', 'fetch'],
  redaction: ['read', 'write'],
  analyse: ['read', 'write', 'run'],
  renfort: [],
};

/** claude의 도구와 그 힘. 이 순서가 화면에 보이는 순서다. */
export const CLAUDE_TOOLS: readonly { tool: string; power: Power }[] = [
  { tool: 'Read', power: 'read' },
  { tool: 'Write', power: 'write' }, { tool: 'Edit', power: 'write' }, { tool: 'Glob', power: 'read' }, { tool: 'Grep', power: 'read' },
  { tool: 'WebSearch', power: 'search' }, { tool: 'WebFetch', power: 'fetch' }, { tool: 'Bash', power: 'run' },
];

/** claude에 넘길 도구: 쓸 수 있는 것과 그중 묻지 않고 쓰는 것. */
export function claudePowers(powers: readonly Power[], access: 'read' | 'write'): { tools: string[]; preapproved: string[] } {
  const usable = CLAUDE_TOOLS.filter((t) => powers.includes(t.power) && (access === 'write' || !MUTATING_POWERS.includes(t.power)));
  return { tools: usable.map((t) => t.tool), preapproved: usable.filter((t) => !MUTATING_POWERS.includes(t.power)).map((t) => t.tool) };
}

/** 직무별 Claude Code 도구. */
export const ROLE_TOOLS = Object.fromEntries(
  (Object.keys(ROLE_POWERS) as Role[]).map((r) => [r, claudePowers(ROLE_POWERS[r], 'write').tools]),
) as Record<Role, string[]>;

/** 각 도구가 하는 일, 한국어로(직무 카드에 쓴다). */
export const TOOL_INFO: Record<string, string> = {
  Read: '파일 읽기', Write: '파일 만들기',
  Edit: '파일 고치기', Glob: '파일 찾기', Grep: '파일 안에서 찾기', WebSearch: '인터넷 검색',
  WebFetch: '웹 페이지 읽기', Bash: '명령 실행',
};

/** 직무별 로봇 이름(한 미션 안에서 같은 이름은 두 번 쓰지 않는다). */
export const NAMES: Record<Role, string[]> = {
  chef: ['맥스'],
  recherche: ['아이리스', '위고', '레아', '말로', '조에', '노에', '이네스', '톰', '자드', '사샤', '루', '닐스'],
  code: ['에이다', '리누스', '그레이스', '앨런', '마거릿', '데니스'],
  design: ['프리다', '코코', '앙리', '소니아', '솔'],
  redaction: ['콜레트', '빅토르', '시몬', '쥘', '조지'],
  analyse: ['마리', '블레즈', '에밀리', '가스파르', '에이다'],
  renfort: ['밥', '룰루', '가스통', '니나', '모모', '키키'],
};

const base = (p: unknown) => (typeof p === 'string' ? p.split(/[\\/]/).filter(Boolean).pop() ?? p : '');
export const cut = (s: unknown, n = 60) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
export const host = (u: unknown) => {
  try { return new URL(String(u)).hostname.replace(/^www\./, ''); } catch { return cut(u, 40); }
};

const MCP_NAMES: Record<string, string> = {
  gmail: 'Gmail', google_drive: 'Google Drive', notion: 'Notion', google_calendar: 'Google 캘린더', calendar: 'Google 캘린더',
  slack: 'Slack', github: 'GitHub', stripe: 'Stripe', hubspot: 'HubSpot', airtable: 'Airtable',
};

/** MCP 커넥터의 읽기 쉬운 이름: mcp__claude_ai_Gmail__search_threads → Gmail */
export function mcpName(tool: string): { server: string; action: string } {
  const parts = tool.split('__');
  const raw = (parts[1] ?? '').replace(/^claude_ai_/, '').replace(/^plugin_[^_]+_/, '');
  const server = MCP_NAMES[raw.toLowerCase()] ?? raw.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return { server, action: (parts[2] ?? '').replace(/[_-]+/g, ' ') };
}

/** 행동, 그 문구(말풍선용, 짧게), 전체 내용(패널용). */
export function describeAct(tool: string, input: Record<string, unknown> | undefined): { kind: ActKind; label: string; detail: string } {
  const i = input ?? {};
  switch (tool) {
    case 'WebSearch': return { kind: 'search', label: `“${cut(i.query, 44)}” 검색 중`, detail: String(i.query ?? '') };
    case 'WebFetch': return { kind: 'web', label: `${host(i.url)} 읽는 중`, detail: String(i.url ?? '') };
    case 'Read': return { kind: 'read', label: `${cut(base(i.file_path), 36)} 읽는 중`, detail: String(i.file_path ?? '') };
    case 'Glob': return { kind: 'read', label: '폴더 뒤지는 중', detail: String(i.pattern ?? '') };
    case 'Grep': return { kind: 'read', label: `“${cut(i.pattern, 30)}” 찾는 중`, detail: `${i.pattern ?? ''}${i.path ? ' (위치: ' + i.path + ')' : ''}` };
    case 'LS': return { kind: 'read', label: '폴더 살펴보는 중', detail: String(i.path ?? '') };
    case 'Write': return { kind: 'write', label: `${cut(base(i.file_path), 36)} 작성 중`, detail: String(i.file_path ?? '') };
    case 'Edit':
    case 'MultiEdit': return { kind: 'edit', label: `${cut(base(i.file_path), 34)} 수정 중`, detail: String(i.file_path ?? '') };
    case 'NotebookEdit': return { kind: 'edit', label: `${cut(base(i.notebook_path), 34)} 수정 중`, detail: String(i.notebook_path ?? '') };
    case 'Bash': {
      const c = String(i.command ?? '').replace(/\s+/g, ' ').trim();
      return { kind: 'bash', label: `${c.length <= 34 ? `“${c}”` : cut(i.description || c, 40)} 실행 중`, detail: String(i.command ?? '') };
    }
    case 'Skill': return { kind: 'skill', label: `${cut(i.skill ?? i.name, 24)} 스킬 쓰는 중`, detail: String(i.args ?? '') };
    case 'ToolSearch': return { kind: 'other', label: '알맞은 도구 찾는 중', detail: String(i.query ?? '') };
  }
  if (tool.startsWith('mcp__')) {
    const { server, action } = mcpName(tool);
    return { kind: 'mcp', label: `${server} 쓰는 중`, detail: action };
  }
  return { kind: 'other', label: `${tool} 쓰는 중`, detail: '' };
}

export const emptyStats = (): MissionStats => ({ agents: 0, searches: 0, pages: 0, reads: 0, writes: 0, commands: 0 });

/** 미션 카운터(검색 수, 읽은 페이지 수…). 이벤트마다 갱신한다. */
export function countStats(s: MissionStats, ev: OfficeEvent) {
  if (ev.k === 'hire') s.agents++;
  if (ev.k !== 'act') return;
  if (ev.kind === 'search') s.searches++;
  else if (ev.kind === 'web') s.pages++;
  else if (ev.kind === 'read') s.reads++;
  else if (ev.kind === 'write' || ev.kind === 'edit') s.writes++;
  else if (ev.kind === 'bash') s.commands++;
}

/** 미션 폴더의 전체 경로가 나오는 곳을 모두 “.”로 바꾼다. JSON으로 쓴 글에서도 된다(따옴표가 `\"`가 된다). */
export function relToFolder(text: string, folder: string): string {
  if (!folder) return text;
  const esc = folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(esc + '(?=$|[/"\'\\s\\\\])', 'g'), '.').replace(/(^|[\s"'])\.\//g, '$1');
}

/** 실행될 명령을 그대로, 읽기 쉽게만 바꾼 것(미션 폴더는 “.”가 된다). 숨기는 것은 없다. */
export function readableCommand(cmd: unknown, folder: string): string {
  return relToFolder(String(cmd ?? ''), folder).trim().replace(/^cd\s+(?:"\."|'\.'|\.)\s*&&\s*/, '');
}

const FULL_MAX = 72;

/**
 * 허락 요청: 말풍선 문구, 전체 내용, 그리고 `full`
 * (말풍선이 행동 전체를 보여 줄 때만 참이다. 그때는 말풍선에서 바로 답할 수 있다).
 */
export function permissionText(tool: string, input: Record<string, unknown> | undefined, folder: string): { label: string; detail: string; full: boolean } {
  const i = input ?? {};
  if (tool === 'Bash') {
    const c = readableCommand(i.command, folder);
    const full = c.length > 0 && c.length <= FULL_MAX && !c.includes('\n');
    return { label: `“${full ? c : cut(c, 48)}” 실행해도 될까요?`, detail: c, full };
  }
  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    const raw = String(i.file_path ?? i.notebook_path ?? '');
    const rel = relToFolder(raw, folder);
    const inside = !!folder && raw.startsWith(folder + '/') && !rel.includes('..');
    return { label: `${inside ? rel : raw} ${tool === 'Write' ? '작성해도' : '수정해도'} 될까요?`, detail: raw, full: inside && rel.length <= FULL_MAX };
  }
  if (tool === 'WebFetch') return { label: `${host(i.url)} 읽어도 될까요?`, detail: String(i.url ?? ''), full: false };
  const detail = relToFolder(JSON.stringify(i, null, 2), folder);
  const clipped = detail.length > 1500 ? detail.slice(0, 1499) + '…' : detail;
  if (tool.startsWith('mcp__')) {
    const { server, action } = mcpName(tool);
    return { label: `${server}(${action}) 써도 될까요?`, detail: clipped, full: false };
  }
  return { label: `${tool} 써도 될까요?`, detail: clipped, full: false };
}
