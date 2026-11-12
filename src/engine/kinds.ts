// 일꾼을 돌리는 CLI의 이름과 배지 색. 직무(Role)와는 따로다: 직무는 모습·구역·이름, CLI는 작은 배지.
import type { AgentInfo, AgentKind } from '../../shared/protocol.ts';

export const KIND: Record<AgentKind, { label: string; color: string }> = {
  claude: { label: 'Claude Code', color: '#ff8a3d' },
  codex: { label: 'Codex', color: '#ffffff' },
  gemini: { label: 'Gemini', color: '#4f8cff' },
};

/**
 * 이 컴퓨터에서 일꾼으로 쓸 수 있는 CLI를 한국어 문구로: "(Claude Code, Codex)".
 * 서버의 hello.agents에서 found인 것만 센다(이 버전이 지원하지 않는 CLI는 found가 아니다). 하나도 없으면 빈 글.
 */
export const agentList = (installed: readonly AgentInfo[]) => {
  const names = installed.filter((a) => a.found).map((a) => KIND[a.kind].label);
  return names.length ? `(${names.join(', ')})` : '';
};
