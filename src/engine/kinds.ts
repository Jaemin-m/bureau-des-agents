// 일꾼을 돌리는 CLI의 이름과 배지 색. 직무(Role)와는 따로다: 직무는 모습·구역·이름, CLI는 작은 배지.
import type { AgentKind } from '../../shared/protocol.ts';

export const KIND: Record<AgentKind, { label: string; color: string }> = {
  claude: { label: 'Claude Code', color: '#ff8a3d' },
  codex: { label: 'Codex', color: '#ffffff' },
  gemini: { label: 'Gemini', color: '#4f8cff' },
};
