// 어댑터를 가져오는 곳은 여기 하나다. 새 CLI를 AgentKind에 넣고 여기를 빼먹으면 타입 오류가 난다.
import type { AgentKind } from '../../shared/protocol.ts';
import type { AdapterProbe, AgentAdapter } from './adapter.ts';
import { claudeAdapter } from './claude.ts';
import { codexAdapter } from './codex.ts';

export { openLegacyLead, type LegacyLead, type LegacyLeadHandlers, type TurnResult } from './claude.ts';

function unsupported(kind: AgentKind, vendor: string): AgentAdapter {
  return {
    kind,
    probe: async (): Promise<AdapterProbe> => ({
      kind, found: false, vendor, note: '이 버전은 지원하지 않아요',
      caps: { approvals: false, steer: false, liveSession: false, web: false, hostTools: false },
    }),
    open: () => { throw new Error(`이 버전은 ${kind}를 지원하지 않아요`); },
  };
}

const ADAPTERS: Record<AgentKind, AgentAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  gemini: unsupported('gemini', 'Google'),
};

export const adapterFor = (kind: AgentKind): AgentAdapter => ADAPTERS[kind];
