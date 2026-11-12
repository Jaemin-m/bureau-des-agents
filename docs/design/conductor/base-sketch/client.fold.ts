// src/state/store.ts + src/engine/world.ts + src/ui/* (SKETCH of the deltas). The client stays a pure fold over OfficeEvent (C2): live, hello-restore,
// replay and demo share one code path. New kinds are handled in BOTH `live` branches (animate vs snap).
import type { OfficeEvent, AgentKind, WorkerPhase, BlockReason, TaskState, TaskResult, Role } from './shared.protocol.ts';

// ── store ────────────────────────────────────────────────────────────────────
export interface AgentViewExt {
  agent: AgentKind;                // hire.agent ?? 'claude' (legacy logs)
  phase: WorkerPhase;              // hire => 'working'; legacy `leave` removes as before; `worker` events set it (idempotent)
  block?: BlockReason;
  taskKey?: string;
  parked?: boolean;
  thread: { id: string; from: string; to: string; kind: string; text: string; at: number }[];   // capped 50, from `msg`
}
export interface TaskView { key: string; title: string; after: string[]; state: TaskState; worker?: string; agent?: AgentKind; role?: Role; result?: TaskResult; note?: string }
export interface StoreExt {
  tasks: Record<string, TaskView>; // upsert by key from `task` events
  asks: { requestId: string; who: string; kind: 'approval' | 'question'; label: string; detail: string; options?: string[] }[]; // ALL open asks (AskBar shows a stack, not the first)
}
// apply(ev) additions (no `default` case needed, unknown kinds stay no-ops):
//   'hire'   -> dedup by id (gotcha 3): update in place if present instead of appending to `order`
//   'worker' -> agents[id].phase/block/taskKey/parked = ev ; drives badge + feed line (해요체: "에이다가 질문했어요")
//   'task'   -> tasks[key] = ev (full node)
//   'msg'    -> agents[to|from].thread.push ; user->worker lines appear in that worker's card and as a feed line, NOT as `start`
//   'end' with stay:true -> do NOT clear asks, do NOT mark agents gone (world keeps seats); plain `end` unchanged (legacy)
// Selectors returning arrays/objects use useShallow (C27).

// ── world ────────────────────────────────────────────────────────────────────
export interface WorldDelta {
  // seat policy (world.assignSeat): role desk -> any free desk -> lounge (sofa x3, new SPOTS.lounge) -> overflow spots -> stacked with a "+N" counter.
  // Idle workers are the first to give up a desk: when a new worker finds no seat, the longest-idle `idle`/`parked` robot walks to the lounge and frees its desk (reclaimSeat).
  // report: `a.reported` resets on worker{phase:'working'} so a long-lived robot can deliver again (gotcha 4); after delivering it walks back to its seat instead of leaving.
  // ask_done: world keeps askOwner: Map<requestId, who>; decrement THAT robot (gotcha 7).
  // badges (drawn in render.ts after the sprite, 5x7 px font.ts glyphs, no new images):
  //    agent kind: C / X / G chip on the antenna colour;  phase: working = typing anim (today), blocked = raised hand + '?' (question) or '!' (approval),
  //    idle = small check, parked = 'zZ', failed = cross, provisioning = box dots.
  // board (BOARD 96x35 px): 4 lines max, topological, "↳" indent by depth, + "대기 3 · 완료 5" counter line.
}
