// Sketch: server/orchestra/prompts.ts (REPLACES server/team.ts; role prompts and COMMON move here unchanged except branding).
// Korean instructions; tool names stay English identifiers.

import type { Role } from '../../shared/protocol.ts';
import type { AgentKind, Workspace } from '../../shared/protocol.additions.ts';
import type { Powers } from '../agents/driver.ts';

/**
 * Role → powers. The ONE list; claude's ROLE_TOOLS (shared/activity.ts, shown in the team room) is derived from it via
 * claudeTools(), codex maps write→sandbox, gemini maps it at the approval step.
 *   recherche {web}  code {write, shell, web}  design {write, web}  redaction {write}  analyse {write, shell}
 *   chef      {write (mission folder only), web}   renfort {write}
 */
export declare const ROLE_POWERS: Record<Role, Powers>;

/**
 * Max's appended system prompt. Key rules (replacing "use the Agent tool"):
 *  - 팀원은 별도 프로그램이다. office 도구 plan으로 일을 나누고 의존 관계(after)를 적는다. 사무실이 준비된 일을 알아서 시작한다.
 *  - 계획을 올린 뒤 턴을 끝낸다. 기다리거나 확인하려고 반복 호출하지 않는다. 소식이 생기면 사무실이 깨운다.
 *  - 팀원 질문은 일과 대표님 지시로 답할 수 있으면 message로 답하고, 아니면 ask_user로 대표님께 묻는다.
 *  - 모든 일이 끝나면 결과를 미션 폴더에 합치고(코드 저장소 미션이면 브랜치 목록과 추천 병합 순서를 적고) finish를 부른다.
 *  - (repo) 저장소는 읽기 전용 사본(lens)으로만 본다. 코드를 직접 고치지 않는다.
 *  - 기존 규칙(한국어, 해요체, 경로 대신 파일 이름, 숫자 지어내지 않기, 사무실 규칙.md) 유지. "VibesMoney" 브랜딩 제거.
 */
export declare function leadInstructions(rules: string, ws: Workspace, installed: AgentKind[]): string;

/**
 * Worker instructions: role prompt + COMMON + office protocol:
 *  - 끝나면 office 도구 done(summary)으로 보고하고 턴을 끝낸다. done을 못 부르면 마지막 메시지가 보고서가 된다.
 *  - 막히면 ask(question, to)로 묻고 바로 턴을 끝낸다. 답은 다음 메시지로 온다.
 *  - (repo) 이 폴더는 너만의 작업 공간(브랜치 <branch>)이다. 커밋하지 않는다. 사무실이 대신 저장한다. 다른 폴더를 건드리지 않는다.
 */
export declare function workerInstructions(role: Role, title: string, ws: Workspace, branch?: string): string;
