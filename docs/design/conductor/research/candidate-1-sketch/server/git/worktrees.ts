// Sketch: server/git/worktrees.ts (NEW). Every git operation the office performs, and nothing else performs one.
//
// Safety rules (the module's whole reason to exist):
//   R1 Never lose work: no `--force`, no `branch -D`, no `reset --hard`, no checkout in the user's main worktree except
//      the explicit merge. Leftover changes are committed to the worker's own branch before a worktree is removed.
//   R2 Idempotent: ensureWorktree / saveWork / releaseWorktree / archiveBranch can run twice or after a crash halfway.
//   R3 Paths: worktrees live only under <BUREAU_DIR>/.bureau/worktrees/<missionId>/<workerId>. Before any destructive
//      call the target is realpath'd and must be strictly inside that root (fixes lexical-only containment, C10).
//   R4 Names: branches are `bureau/<missionId>/<taskKey>[-n]`, validated by regex; refs passed to git after `--`.
//   R5 Shell: execFile('git', ['-C', dir, …]) only, never a shell string; 30 s timeout; LC_ALL=C for parsable output.
// Paths returned here go to the ledger (server-only). Events carry only branch names (C24).

export interface RepoInfo { root: string; base: string; baseSha: string }

export interface WorktreeRef {
  repo: string;
  path: string;
  branch: string;
  /** commit the branch started from (base sha, upstream tip, or an office integration commit) */
  start: string;
}

/**
 * Browser-supplied repo path → validated repo. Must be absolute, exist, be the top level
 * (`rev-parse --show-toplevel` === realpath), not be inside BUREAU_DIR, and not be bare. base = current branch
 * (detached HEAD ⇒ refused: '브랜치에 있는 저장소만 쓸 수 있어요').
 */
export async function validateRepo(p: string, officeDir: string): Promise<RepoInfo> { throw new Error('not implemented'); }

/**
 * Start point for a task whose upstream tasks produced branches.
 *   no upstream branches with commits → baseSha
 *   one                                → its tip
 *   several                            → integration commit built WITHOUT touching any work tree:
 *                                        tree = `git merge-tree --write-tree a b …` (folded pairwise),
 *                                        sha  = `git commit-tree tree -p a -p b …` (C17)
 *   any pairwise conflict              → { conflict: [branches] }
 */
export async function startPointFor(repo: string, baseSha: string, upstream: string[]): Promise<{ sha: string } | { conflict: string[] }> {
  throw new Error('not implemented');
}

/**
 * TODO idempotent create:
 *   path exists and `worktree list --porcelain` shows it on `branch` → return as is
 *   path exists but is not that worktree                           → throw (never reuse a foreign dir)
 *   branch exists, no worktree                                     → git worktree add <path> <branch>
 *   neither                                                        → git worktree add -b <branch> <path> <start>
 *   branch name taken by an unrelated branch                       → suffix -2, -3 …
 */
export async function ensureWorktree(repo: string, root: string, missionId: string, workerId: string, taskKey: string, start: string): Promise<WorktreeRef> {
  throw new Error('not implemented');
}

/** Read-only lens for Max in repo missions: detached worktree at baseSha (`_lead`). Writes there are harmless and kept if dirty. */
export async function ensureLens(repo: string, root: string, missionId: string, baseSha: string): Promise<string> { throw new Error('not implemented'); }

/**
 * Commit leftovers on the worker's branch: `add -A`, then commit only if the index differs from HEAD.
 * Identity: repo's own user.name/email if set, else `-c user.name=에이전트 사무실 -c user.email=office@localhost`.
 * Message: `[사무실] <task title>` + trailer `Bureau-Task: <missionId>/<taskKey>`. Hooks skipped? NO: hooks run
 * (user policy wins); a failing hook ⇒ { committed:false, problem } and the worktree is kept.
 */
export async function saveWork(wt: WorktreeRef, title: string, trailer: string): Promise<{ committed: boolean; problem?: string }> {
  throw new Error('not implemented');
}

export async function summarize(repo: string, baseSha: string, branch: string): Promise<{ ahead: number; files: string[] }> { throw new Error('not implemented'); }

/** After saveWork: clean ⇒ `worktree remove` (no --force) + `branch -d` if ahead===0; dirty or failed ⇒ 'kept'. */
export async function releaseWorktree(wt: WorktreeRef, root: string): Promise<'removed' | 'kept'> { throw new Error('not implemented'); }

/** "버리기": one `update-ref --stdin` transaction: create refs/bureau/archive/<missionId>/<name>-<ts> = tip; delete refs/heads/<branch> <tip>. Recoverable forever. */
export async function archiveBranch(repo: string, branch: string): Promise<string> { throw new Error('not implemented'); }

/**
 * "합치기" into the user's checkout. Refused (Korean reason) unless: checkout is on `base`, `status --porcelain` is empty,
 * merge-tree pre-check is clean. Then `merge --no-ff --no-edit <branch>`; any failure ⇒ `merge --abort`.
 */
export async function mergeIntoCheckout(repo: string, base: string, branch: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  throw new Error('not implemented');
}

/** For restore(): office worktrees of this mission as git sees them (path, branch, prunable). */
export async function inventory(repo: string, root: string, missionId: string): Promise<{ path: string; branch?: string; prunable: boolean }[]> {
  throw new Error('not implemented');
}

/** realpath(target) strictly inside realpath(root) — the only containment check this module uses. */
export async function assertInside(root: string, target: string): Promise<string> { throw new Error('not implemented'); }
