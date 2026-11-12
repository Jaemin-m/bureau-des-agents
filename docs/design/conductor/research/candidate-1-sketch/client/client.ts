// Sketch: client changes (src/state/store.ts, src/engine/world.ts, layout.ts, robots.ts, icons.ts, ui/*).
// The client still knows only OfficeEvent. It gains no knowledge of CLIs beyond the AgentKind label/colour.

import type { Role } from '../shared/protocol.ts';
import type { AgentKind, WorkerState } from '../shared/protocol.additions.ts';
import type { MissionView } from '../shared/mission.ts';

// ── store.ts ──
// + view: MissionView        folded with foldMission in apply() for EVERY event (live or not), before the per-kind switch.
// The existing per-kind fields (agents, order, asks, chef, plan…) stay for old behaviour; changes:
//   hire        → if s.agents[id] exists: re-entry (status 'working', no push to order)          (gotcha 3)
//   msg         → feed line: question '❓ 에이다 → 맥스: …', followup '나 → 에이다: …', answer '맥스 → 에이다: …'
//   worker      → agents[who].status mapped for old components: working|starting|interrupted→'working',
//                 idle→'done' (but robot stays), failed|stopped→'failed'; AgentView += state: WorkerState
//   task/branch → only view changes (no per-kind field: single source)
//   end         → unchanged (clears asks, busySince)
// Selectors (useShallow where they return arrays, C27):
export declare function boardItems(s: { view: MissionView; plan: { text: string; status: string }[] }): { text: string; status: string; depth?: number }[];
//   = view.taskOrder.length ? tasks projected (blocked/ready→pending, running→in_progress, done→completed) : s.plan
//   so the chalkboard keeps drawing old missions from `plan` and new ones from the DAG — derived, never duplicated in the log.
export declare function pendingForUser(s: { view: MissionView }): { kind: 'approval' | 'question'; id: string; who: string; text: string }[];
//   = open asks ∪ openQuestions(view, 'user'), oldest first → AskBar lists all of them (not just the first).

// ── world.ts ──
// Seat policy (C20) — one function, replaces assignSeat:
export declare function seatFor(role: Role, state: WorkerState, free: { desks: string[]; lounge: string[]; overflow: string[] }):
  { at: 'desk' | 'lounge' | 'overflow' | 'offstage'; id?: string };
//   starting|working|waiting|interrupted → own-zone desk → any free desk (hot-desk) → overflow spot → overflow[0] stack
//   idle|stopped|failed                  → release desk, walk to a lounge spot (sofa/coffee, 6 spots) → none free: walk out
//                                          the door but STAY in the roster ('offstage'); walks back in on re-entry
//   gone                                 → exit (today's `leave` choreography, unchanged)
// With maxWorkers ≤ 8 working at once, 16 desks are never exhausted by working robots; overflow is for old logs.
// worker event handler: re-run seatFor on state change and queue walk tasks (live) or snap (replay/hello).
// ask_done: decrement the actor of view.asks[requestId].who captured BEFORE the fold deletes it (fix gotcha 7).
// end: unchanged (everyone walks out) — the server releases workers at end anyway, so semantics agree.

// ── layout.ts ──  SPOTS.lounge: 6 tiles in front of the sofa (2..4,13) and coffee bar (16..18,13); asserted walkable at load.

// ── robots.ts / icons.ts ──
export const KIND_LIGHT: Record<AgentKind, string> = { claude: '#E8834A', codex: '#F2F2F2', gemini: '#5B8CFF' };
//   2×2 px antenna light drawn over the cached sprite (not part of the sprite cache key: one blit per robot per frame).
//   Legacy subagents (agent undefined) draw no light — honest: they were not separate CLIs.
//   New icons: '?' bubble (state waiting / open question from this worker) and a 3×4 px flag (branch ready).
//   Existing '!' alert stays for approvals.

// ── camera.ts ── msg{question} → short close-up on the asker; branch{ready} → nudge toward the robot. Others unchanged.

// ── ui ──
// Dialog.tsx  Composer: recipient chip ("맥스에게" default; clicking a robot or a question sets "에이다에게"/"답장");
//             sends {t:'say', text, to, replyTo}. Start mode: workspace toggle "폴더 / 코드 저장소" + repo path field
//             (recent repos from settings.repos). AskBar: pendingForUser list, each with 허락/거절 or 답장.
// Rooms.tsx   Agent room: CLI line ("Codex로 일해요" / old logs: "Claude Code 서브에이전트였어요"), state chip, task brief,
//             message thread (view.msgs filtered by party), composer "이 팀원에게 말하기", 멈추기 button,
//             branch card (ahead, files, 변경 보기 → {t:'diff'}, 합치기, 버리기 with confirm).
//             Board room: DAG as an HTML list by layers(view) ("기다리는 일: 조사"), status chips. No graph library.
//             Copy (C25): "진짜 Claude Code 서브에이전트" → "진짜 에이전트 프로그램(Claude Code · Codex · Gemini)".
// Panel.tsx   team list ordered by view.workerOrder with state chips (일하는 중 · 질문 있어요 · 쉬는 중 · 멈춤 · 실패).
// tidy.ts     + patterns for <office>/.bureau/worktrees/** and settings.repos roots → "작업 공간"/"저장소 이름".
// Strings: all new copy Korean 해요체 (C23).

export type _Refs = [Role];
