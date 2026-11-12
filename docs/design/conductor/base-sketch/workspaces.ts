// server/workspaces.ts (SKETCH): the only module that runs git or creates directories for workers.
// Deep module: callers say what the worker needs; this module owns branch naming, paths, idempotency, checkpoints, and "never lose work".
import type { AbsPath, ServerTarget, Access, WorkerId, TaskKey, WorkspaceRef } from './conductor.model.ts';

/** Everything in here is derived from ids the Conductor minted. No path segment, branch name or git argument comes from a model or the browser. */
export interface WorkspaceSpec {
  worker: WorkerId;
  task: TaskKey;
  access: Access;
  /** repo missions: tasks whose output this task builds on. Their branch heads become this task's start point (see compose below). */
  upstream: { task: TaskKey; branch: string }[];
}

export type Provisioned =
  | { ok: true; ref: WorkspaceRef; adopted: boolean /* found the previous run's worktree and reused it */ }
  | { ok: false; why: string; transient: boolean };

export interface Checkpoint { dirty: boolean; committed: boolean; head: string; /** HEAD was not on the expected branch: nothing committed, work preserved as-is */ branchMoved: boolean }

export interface Review {
  branch: string; base: string; head: string; commits: number; files: number; ins: number; del: number;
  /** from `git merge-tree --write-tree base head`: touches no work tree and no ref */
  mergeable: 'clean' | 'conflict' | 'unknown';
}

export interface OrphanReport { adopted: WorkspaceRef[]; quarantined: { path: string; movedTo: string }[]; prunedMeta: number }

export interface Workspaces {
  /**
   * Idempotent by (missionId, task): running it twice, or after a crash at any step, yields the same worktree.
   *   folder target / access 'read' -> { kind:'folder'|'readonly' }, nothing created.
   *   repo + 'write' -> branch `office/<missionSlug>/<taskKey>` at the start point:
   *       no upstream: baseSha | one upstream: that branch head | several: baseSha then `git merge --no-edit` each head inside the NEW worktree
   *       (a conflict aborts the merge, leaves the worktree clean at baseSha, returns ok:false why:'upstream conflict' => task blocked, Max/user decide).
   *   TODO(steps, each re-runnable):
   *     1. realpath(worktreeRoot) must exist and be a directory we created (marker file `.office-root`); path = worktreeRoot/<missionSlug>/<taskKey>
   *     2. `git worktree list --porcelain`: registered at path with our branch -> adopt. branch exists, no worktree -> `git worktree add <path> <branch>` (never reset it).
   *        path exists but is NOT registered -> rename to <path>.orphan-<ts> (quarantine), never delete, then add fresh.
   *     3. otherwise `git worktree add -b <branch> <path> <start>`.
   *     4. post-check: `rev-parse --show-toplevel` at path === path, HEAD branch === ours. Else ok:false.
   */
  provision(t: ServerTarget, missionId: string, spec: WorkspaceSpec): Promise<Provisioned>;
  /**
   * Office-made commit so every finished turn has a durable result, whatever CLI did the work, and without the worker needing write access
   * to <repo>/.git (codex/gemini sandboxes cannot write the worktree's gitdir; claude --restricted asks for approval on git writes).
   * `git add -A` then `git -c commit.gpgsign=false commit --no-verify` only if dirty and HEAD is still our branch. Identity: repo's if configured, else office fallback.
   * Respects .gitignore, so node_modules are never committed.
   */
  checkpoint(ref: WorkspaceRef, message: string): Promise<Checkpoint>;
  review(ref: WorkspaceRef, baseSha: string): Promise<Review>;
  /**
   * Worker retired. Checkpoint first, then `git worktree remove` WITHOUT --force. If git refuses (ignored build output etc.) the folder is kept
   * and the ref becomes 'retained'. The BRANCH IS ALWAYS KEPT: results come back as branches. Deleting a branch is a separate user action (discard()).
   */
  retire(ref: WorkspaceRef): Promise<WorkspaceRef>;
  /** User-confirmed only. `git branch -d`; if unmerged, `-D` only when confirmSha === current tip, and the tip sha is appended to .bureau/trash.json so it is recoverable. */
  discardBranch(t: ServerTarget, branch: string, confirmSha: string): Promise<{ ok: boolean; why?: string }>;
  /** Guarded merge for the "합치기" button (U13): main checkout must be on baseBranch, clean, and merge-tree must say clean. Else returns a Korean reason; never touches the checkout. */
  mergeIntoBase(t: ServerTarget, branch: string): Promise<{ ok: boolean; why?: string }>;
  /** Boot: list worktrees under worktreeRoot for this mission, adopt registered ones, quarantine unregistered dirs, `git worktree prune` metadata for vanished ones. */
  reconcile(t: ServerTarget, missionId: string): Promise<OrphanReport>;
  /** Poll for `file` events in a worktree: `git status --porcelain=v1 -z` (bounded, .gitignore-aware). Replaces fs.watch for repos, and makes `by` exact. */
  changed(ref: WorkspaceRef): Promise<{ path: string; isNew: boolean }[]>;
}

/** Repo intake, run when the user picks a folder in the composer ({t:'repo_check'}) and again at start. */
export interface RepoCheck { ok: boolean; why?: string; root?: AbsPath; label?: string; branch?: string; sha?: string; dirty?: boolean }
export function checkRepo(userPath: string, office: { dir: AbsPath; home: AbsPath }): Promise<RepoCheck> {
  throw new Error('not implemented');
  // realpath(userPath); must be an existing dir; `git rev-parse --show-toplevel` must equal it (user points at the root, not a subfolder);
  // reject: '/', $HOME itself, anything inside office.dir/.bureau, bare repos, repos mid-merge/rebase, detached HEAD (no baseBranch to name).
  // dirty main checkout is ALLOWED (worktrees branch from baseSha, the checkout is never touched); the UI says "작업 중인 파일은 건드리지 않아요".
}

// server/roots.ts (SKETCH): replaces lexical `inside()` (gotcha 13). Used by read / versions / preview / open.
export interface Roots { all(missionId: string): AbsPath[] } // mission folder + live worktree paths + report dir
export function resolveInside(roots: readonly AbsPath[], requested: string): Promise<AbsPath | null> {
  throw new Error('not implemented');
  // path.resolve against each root, then fs.realpath, then path.relative(root, real) must not start with '..' or be absolute. Symlink escape => null.
}
