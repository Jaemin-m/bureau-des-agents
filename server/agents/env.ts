// 자식 프로세스의 환경을 정하는 곳은 여기 하나다. 사용자의 구독으로 돌아가도록 API 키를 모두 뺀다.
import type { AgentKind } from '../../shared/protocol.ts';

const API_KEY_VARS: Record<AgentKind, string[]> = {
  claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  codex: ['OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
};

/** BUREAU_USE_API_KEY=1이면 키를 그대로 둔다(사용량 과금). */
export const useApiKeys = () => process.env.BUREAU_USE_API_KEY === '1';

export function childEnv(kind: AgentKind, base: NodeJS.ProcessEnv, keepApiKeys: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, BUREAU_DES_AGENTS: '1' };
  if (!keepApiKeys) for (const name of API_KEY_VARS[kind]) delete env[name];
  return env;
}
