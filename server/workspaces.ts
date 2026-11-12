// The only module that runs git. Callers state what a worker needs; names, paths, idempotency and "never lose work" live here.
// Every path segment, branch name and git argument derives from a minted mission id or a `[a-z0-9-]` task key.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, rename, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { contains, realOrNull } from './roots.ts';

export interface Repo { root: string; baseBranch: string; baseSha: string; label: string }
export type RepoCheck = { ok: true; repo: Repo; dirty: boolean } | { ok: false; why: string };
export interface Mission { id: string; repo: Repo }
export type Access = 'read' | 'write';
export interface WorkspaceSpec { mission: Mission; task: string; access: Access; upstream: readonly string[] }

interface RefBase { repo: Repo; mission: string; task: string; path: string }
export type BranchRef = RefBase & { kind: 'branch'; branch: string };
export type LensRef = RefBase & { kind: 'lens' };
export type WorkspaceRef = BranchRef | LensRef;

export interface Failed { kind: 'failed'; why: string }
export type Provisioned =
  | { kind: 'ready'; ref: WorkspaceRef; adopted: boolean; quarantined: string | null }
  | { kind: 'conflict'; branches: string[] }
  | Failed;

export interface Skipped { path: string; why: 'large' | 'secret' }
export type Checkpoint =
  | { kind: 'clean'; head: string }
  | { kind: 'committed'; head: string; skipped: Skipped[] }
  | { kind: 'heldBack'; skipped: Skipped[] }
  | { kind: 'branchMoved' }
  | { kind: 'refused'; output: string; skipped: Skipped[] }
  | Failed;

export type Retired =
  | { kind: 'removed'; checkpoint: Checkpoint | null }
  | { kind: 'retained'; why: string; checkpoint: Checkpoint | null }
  | Failed;

export type Archived = { kind: 'archived'; archiveRef: string } | Failed;

export type Review = {
  kind: 'review'; branch: string; base: string; head: string;
  commits: number; files: number; ins: number; del: number;
  mergeable: 'clean' | 'conflict' | 'unknown';
} | Failed;

export type Merged = { kind: 'merged'; head: string } | { kind: 'refused'; why: string };

export interface Reconciled { adopted: WorkspaceRef[]; quarantined: string[]; pruned: number }

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const LARGE = 5 * 1024 * 1024;
const SECRET = [/^\.env/i, /\.pem$/i, /\.key$/i, /^id_rsa/i];
const OFFICE_ID = ['-c', 'user.name=에이전트 사무실', '-c', 'user.email=office@localhost'];
// A server started from inside a git hook inherits these, and they would redirect every command to the wrong repository.
const INHERITED = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_PREFIX'];

export function worktreeRoot(): string {
  return path.resolve(process.env.BUREAU_WORKTREES || path.join(os.homedir(), '.bureau-des-agents', 'worktrees'));
}

export function branchName(missionId: string, task: string): string { return `bureau/${name(missionId)}/${name(task)}`; }

function name(s: string): string {
  if (!NAME.test(s)) throw new Fail('이름이 올바르지 않아요');
  return s;
}

class Fail extends Error {}

interface Run { code: number; out: string; err: string }

function run(cwd: string, args: readonly string[], input = ''): Promise<Run> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat', LC_ALL: 'C' };
  for (const k of INHERITED) delete env[k];
  return new Promise((resolve) => {
    const p = spawn('git', ['--no-pager', '-C', cwd, ...args], { env, timeout: 120_000 });
    let out = '', err = '';
    p.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
    p.stderr.setEncoding('utf8').on('data', (d: string) => { err += d; });
    p.on('error', (e) => resolve({ code: -1, out, err: err + e.message }));
    p.on('close', (code) => resolve({ code: code ?? -1, out, err }));
    p.stdin.end(input);
  });
}

async function git(cwd: string, args: readonly string[], input?: string): Promise<string> {
  const r = await run(cwd, args, input);
  if (r.code !== 0) throw new Fail(`git ${args.find((a) => /^[a-z][a-z-]*$/.test(a)) ?? ''} 명령이 실패했어요`);
  return r.out.replace(/\n$/, '');
}

async function maybe(cwd: string, args: readonly string[]): Promise<string | null> {
  const r = await run(cwd, args);
  return r.code === 0 ? r.out.trim() : null;
}

const sha = (cwd: string, rev: string) => maybe(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
const headRef = (cwd: string) => maybe(cwd, ['symbolic-ref', '--quiet', 'HEAD']);
const clip = (s: string) => s.trim().slice(-4000);

function failed(e: unknown): Failed {
  return { kind: 'failed', why: e instanceof Fail ? e.message : '작업 폴더를 다루다가 문제가 생겼어요' };
}

async function identity(cwd: string): Promise<string[]> {
  const set = (await maybe(cwd, ['config', 'user.name'])) && (await maybe(cwd, ['config', 'user.email']));
  return set ? [] : OFFICE_ID;
}

async function midOperation(root: string): Promise<string | null> {
  const ops: [string, string][] = [['rebase-merge', '리베이스'], ['rebase-apply', '리베이스'], ['MERGE_HEAD', '병합'], ['CHERRY_PICK_HEAD', '체리픽'], ['REVERT_HEAD', '되돌리기']];
  const paths = (await git(root, ['rev-parse', ...ops.flatMap(([f]) => ['--git-path', f])])).split('\n');
  const i = paths.findIndex((p) => existsSync(path.resolve(root, p)));
  return i < 0 ? null : ops[i][1];
}

async function dirty(cwd: string): Promise<boolean> {
  return (await git(cwd, ['status', '--porcelain'])) !== '';
}

interface Listed { path: string; head: string | null; branch: string | null }

async function worktrees(root: string): Promise<Listed[]> {
  const out: Listed[] = [];
  for (const field of (await git(root, ['worktree', 'list', '--porcelain', '-z'])).split('\0')) {
    if (field.startsWith('worktree ')) out.push({ path: field.slice(9), head: null, branch: null });
    else if (field.startsWith('HEAD ') && out.length) out[out.length - 1].head = field.slice(5);
    else if (field.startsWith('branch ') && out.length) out[out.length - 1].branch = field.slice(7);
  }
  return out;
}

export async function checkRepo(userPath: string, office: { dir: string; home: string }): Promise<RepoCheck> {
  const no = (why: string): RepoCheck => ({ ok: false, why });
  if (!path.isAbsolute(userPath) || userPath.includes('\0')) return no('폴더 경로가 올바르지 않아요.');
  const real = await realOrNull(userPath);
  if (!real || !(await stat(real)).isDirectory()) return no('폴더를 찾을 수 없어요.');
  const label = path.basename(real);
  if (real === path.parse(real).root) return no('컴퓨터 맨 위 폴더는 쓸 수 없어요.');
  if (real === (await realOrNull(office.home))) return no('홈 폴더 전체는 쓸 수 없어요. 저장소 폴더를 골라 주세요.');
  for (const place of [office.dir, worktreeRoot()]) {
    const p = (await realOrNull(place)) ?? path.resolve(place);
    if (p === real || contains(p, real) || contains(real, p)) return no('사무실 폴더와 겹치는 저장소는 쓸 수 없어요.');
  }
  if ((await maybe(real, ['rev-parse', '--is-inside-work-tree'])) !== 'true') return no(`'${label}' 폴더는 git 저장소가 아니에요.`);
  const top = await maybe(real, ['rev-parse', '--show-toplevel']);
  if (!top || (await realOrNull(top)) !== real) return no('저장소의 맨 위 폴더를 골라 주세요.');
  const op = await midOperation(real);
  if (op) return no(`'${label}' 저장소가 ${op} 중이에요. 끝낸 뒤 다시 골라 주세요.`);
  const baseBranch = await maybe(real, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!baseBranch) return no('브랜치에 있는 저장소만 쓸 수 있어요.');
  const baseSha = await sha(real, 'HEAD');
  if (!baseSha) return no('커밋이 하나도 없는 저장소는 아직 쓸 수 없어요.');
  return { ok: true, repo: { root: real, baseBranch, baseSha, label }, dirty: await dirty(real) };
}

async function missionDir(missionId: string, create: boolean): Promise<string | null> {
  const root = worktreeRoot();
  const dir = path.join(root, name(missionId));
  if (create) await mkdir(dir, { recursive: true });
  const [rootReal, real] = [await realOrNull(root), await realOrNull(dir)];
  if (!rootReal || !real) return null;
  if (real !== path.join(rootReal, missionId)) throw new Fail('작업 폴더 위치가 올바르지 않아요');
  return real;
}

async function quarantine(at: string): Promise<string | null> {
  try { await lstat(at); } catch { return null; }
  const to = `${at}.orphan-${Date.now().toString(36)}`;
  await rename(at, to);
  return to;
}

async function startPoint(repo: Repo, missionId: string, upstream: readonly string[]): Promise<{ sha: string } | { conflict: string[] }> {
  const branches = [...new Set(upstream)].map((t) => branchName(missionId, t));
  if (!branches.length) return { sha: repo.baseSha };
  const heads: string[] = [];
  for (const b of branches) {
    const h = await sha(repo.root, `refs/heads/${b}`);
    if (!h) throw new Fail('앞 할 일의 브랜치가 없어요');
    heads.push(h);
  }
  let acc = heads[0];
  for (let i = 1; i < heads.length; i++) {
    const m = await run(repo.root, ['merge-tree', '--write-tree', '--no-messages', acc, heads[i]]);
    if (m.code === 1) return { conflict: branches.slice(0, i + 1) };
    if (m.code !== 0) throw new Fail('앞 할 일들을 합치지 못했어요');
    const tree = m.out.split('\n')[0];
    acc = await git(repo.root, [...await identity(repo.root), 'commit-tree', tree, '-p', acc, '-p', heads[i], '-m', `사무실: 앞 할 일 합치기 (${branches.slice(0, i + 1).join(', ')})`]);
  }
  return { sha: acc };
}

export async function provision(spec: WorkspaceSpec): Promise<Provisioned> {
  try { return await provisionOrThrow(spec); } catch (e) { return failed(e); }
}

async function provisionOrThrow({ mission, task, access, upstream }: WorkspaceSpec): Promise<Provisioned> {
  const repo = mission.repo;
  const dir = (await missionDir(mission.id, true))!;
  const at = path.join(dir, name(task));
  const base = { repo, mission: mission.id, task, path: at };
  const ref: WorkspaceRef = access === 'write' ? { ...base, kind: 'branch', branch: branchName(mission.id, task) } : { ...base, kind: 'lens' };
  const want = ref.kind === 'branch' ? `refs/heads/${ref.branch}` : null;

  const listed = (await worktrees(repo.root)).find((w) => w.path === at);
  if (listed) {
    if (!existsSync(at)) await git(repo.root, ['worktree', 'remove', at]);
    else if (listed.branch === want) return { kind: 'ready', ref: await postCheck(ref), adopted: true, quarantined: null };
    else throw new Fail('이 할 일의 작업 폴더가 다른 상태로 남아 있어요');
  }

  let add: string[];
  if (ref.kind === 'lens') add = ['worktree', 'add', '--detach', at, repo.baseSha];
  else if (await sha(repo.root, `refs/heads/${ref.branch}`)) add = ['worktree', 'add', at, ref.branch];
  else {
    const start = await startPoint(repo, mission.id, upstream);
    if ('conflict' in start) return { kind: 'conflict', branches: start.conflict };
    add = ['worktree', 'add', '-b', ref.branch, at, start.sha];
  }
  const quarantined = await quarantine(at);
  await git(repo.root, add);
  return { kind: 'ready', ref: await postCheck(ref), adopted: false, quarantined };
}

async function postCheck(ref: WorkspaceRef): Promise<WorkspaceRef> {
  const top = await maybe(ref.path, ['rev-parse', '--show-toplevel']);
  const head = await headRef(ref.path);
  const onBranch = ref.kind === 'branch' ? head === `refs/heads/${ref.branch}` : head === null;
  if (!top || (await realOrNull(top)) !== ref.path || !onBranch) throw new Fail('작업 폴더를 확인하지 못했어요');
  return ref;
}

function parseStatus(z: string): string[] {
  const fields = z.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.length < 4) continue;
    paths.push(f.slice(3));
    if (f[0] === 'R' || f[0] === 'C') i++;
  }
  return paths;
}

async function holdBack(cwd: string, paths: string[]): Promise<Skipped[]> {
  const out: Skipped[] = [];
  for (const p of paths) {
    const st = await lstat(path.join(cwd, p)).catch(() => null);
    if (!st) continue;
    if (SECRET.some((r) => r.test(path.basename(p)))) out.push({ path: p, why: 'secret' });
    else if (st.isFile() && st.size > LARGE) out.push({ path: p, why: 'large' });
  }
  return out;
}

export async function checkpoint(ref: BranchRef, message: string): Promise<Checkpoint> {
  try {
    const cwd = ref.path;
    if ((await headRef(cwd)) !== `refs/heads/${ref.branch}`) return { kind: 'branchMoved' };
    const changed = parseStatus(await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']));
    if (!changed.length) return { kind: 'clean', head: await git(cwd, ['rev-parse', 'HEAD']) };
    const skipped = await holdBack(cwd, changed);
    await git(cwd, ['add', '-A']);
    if (skipped.length) await git(cwd, ['--literal-pathspecs', 'reset', '-q', '--', ...skipped.map((s) => s.path)]);
    if ((await run(cwd, ['diff', '--cached', '--quiet'])).code === 0) return { kind: 'heldBack', skipped };
    // Signing may wait on a pinentry prompt that a headless server can never answer.
    const c = await run(cwd, [...await identity(cwd), '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message]);
    if (c.code !== 0) {
      await git(cwd, ['reset', '-q']);
      return { kind: 'refused', output: clip(c.out + '\n' + c.err), skipped };
    }
    return { kind: 'committed', head: await git(cwd, ['rev-parse', 'HEAD']), skipped };
  } catch (e) { return failed(e); }
}

export async function retire(ref: WorkspaceRef): Promise<Retired> {
  try {
    const root = ref.repo.root;
    if (!existsSync(ref.path)) {
      if ((await worktrees(root)).some((w) => w.path === ref.path)) await git(root, ['worktree', 'remove', ref.path]);
      return { kind: 'removed', checkpoint: null };
    }
    let cp: Checkpoint | null = null;
    if (ref.kind === 'branch') {
      cp = await checkpoint(ref, `사무실: ${ref.task} 남은 작업 저장`);
      if (cp.kind === 'branchMoved' || cp.kind === 'failed') return { kind: 'retained', why: '작업 폴더가 예상과 달라서 그대로 뒀어요.', checkpoint: cp };
    } else if ((await sha(ref.path, 'HEAD')) !== ref.repo.baseSha) {
      return { kind: 'retained', why: '읽기 전용 폴더에 커밋이 생겨서 그대로 뒀어요.', checkpoint: null };
    }
    const r = await run(root, ['worktree', 'remove', ref.path]);
    if (r.code !== 0) return { kind: 'retained', why: '작업 폴더에 저장하지 않은 파일이 남아서 그대로 뒀어요.', checkpoint: cp };
    return { kind: 'removed', checkpoint: cp };
  } catch (e) { return failed(e); }
}

export async function archive(ref: BranchRef): Promise<Archived> {
  try {
    const root = ref.repo.root;
    const head = `refs/heads/${ref.branch}`;
    const prefix = `refs/bureau/archive/${name(ref.mission)}/${name(ref.task)}`;
    const existing = new Map<string, string>();
    for (const line of (await git(root, ['for-each-ref', '--format=%(refname) %(objectname)', `${prefix}`, `${prefix}-*`])).split('\n')) {
      const [r, s] = line.split(' ');
      if (r === prefix || /^-\d+$/.test(r.slice(prefix.length))) existing.set(r, s);
    }
    const tip = await sha(root, head);
    if (!tip) {
      const last = [...existing.keys()].pop();
      if (!last) throw new Fail('보관할 브랜치가 없어요');
      return { kind: 'archived', archiveRef: last };
    }
    if ((await worktrees(root)).some((w) => w.branch === head)) throw new Fail('작업 폴더가 아직 이 브랜치를 쓰고 있어요');
    let target = [...existing].find(([, s]) => s === tip)?.[0];
    if (!target) {
      let n = 1;
      while (existing.has(n === 1 ? prefix : `${prefix}-${n}`)) n++;
      target = n === 1 ? prefix : `${prefix}-${n}`;
      await git(root, ['update-ref', '--stdin'], `create ${target} ${tip}\n`);
    }
    if ((await sha(root, target)) !== tip) throw new Fail('보관 기록을 확인하지 못했어요');
    await git(root, ['update-ref', '-d', head, tip]);
    return { kind: 'archived', archiveRef: target };
  } catch (e) { return failed(e); }
}

async function mergeable(root: string, a: string, b: string): Promise<'clean' | 'conflict' | 'unknown'> {
  const code = (await run(root, ['merge-tree', '--write-tree', '--no-messages', a, b])).code;
  return code === 0 ? 'clean' : code === 1 ? 'conflict' : 'unknown';
}

export async function review(ref: BranchRef): Promise<Review> {
  try {
    const root = ref.repo.root;
    const head = await sha(root, `refs/heads/${ref.branch}`);
    const base = await sha(root, `refs/heads/${ref.repo.baseBranch}`);
    if (!head || !base) throw new Fail('비교할 브랜치가 없어요');
    const commits = Number(await git(root, ['rev-list', '--count', `${base}..${head}`]));
    const stat = await git(root, ['diff', '--shortstat', `${base}...${head}`]);
    const count = (re: RegExp) => Number(re.exec(stat)?.[1] ?? 0);
    return {
      kind: 'review', branch: ref.branch, base: ref.repo.baseBranch, head, commits,
      files: count(/(\d+) files? changed/), ins: count(/(\d+) insertions?/), del: count(/(\d+) deletions?/),
      mergeable: await mergeable(root, base, head),
    };
  } catch (e) { return failed(e); }
}

export async function mergeIntoBase(ref: BranchRef): Promise<Merged> {
  const no = (why: string): Merged => ({ kind: 'refused', why });
  const { root, baseBranch, label } = ref.repo;
  try {
    const op = await midOperation(root);
    if (op) return no(`'${label}' 저장소가 ${op} 중이에요. 끝낸 뒤 합칠 수 있어요.`);
    const current = await maybe(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (current !== baseBranch) return no(`'${label}' 저장소가 ${baseBranch} 브랜치에 있지 않아요. ${baseBranch}로 돌아간 뒤 합칠 수 있어요.`);
    if (await dirty(root)) return no(`'${label}' 저장소에 저장하지 않은 변경이 있어요. 정리한 뒤 합칠 수 있어요.`);
    const tip = await sha(root, `refs/heads/${ref.branch}`);
    if (!tip) return no('합칠 브랜치가 없어요.');
    const verdict = await mergeable(root, 'HEAD', tip);
    if (verdict !== 'clean') return no(verdict === 'conflict' ? `${baseBranch}와 충돌이 나서 합칠 수 없어요.` : '합칠 수 있는지 확인하지 못했어요.');
    const m = await run(root, [...await identity(root), 'merge', '--no-ff', '--no-edit', ref.branch]);
    if (m.code !== 0) {
      if ((await midOperation(root)) === '병합') await run(root, ['merge', '--abort']);
      return no(`합치기가 멈췄어요.\n${clip(m.out + '\n' + m.err)}`);
    }
    return { kind: 'merged', head: await git(root, ['rev-parse', 'HEAD']) };
  } catch (e) { return no(failed(e).why); }
}

export async function reconcile(mission: Mission): Promise<Reconciled> {
  const report: Reconciled = { adopted: [], quarantined: [], pruned: 0 };
  const dir = await missionDir(mission.id, false);
  if (!dir) return report;
  const repo = mission.repo;
  const ours = (await worktrees(repo.root)).filter((w) => path.dirname(w.path) === dir);
  for (const w of ours) {
    const task = path.basename(w.path);
    if (!existsSync(w.path)) {
      await git(repo.root, ['worktree', 'remove', w.path]);
      report.pruned++;
    } else if (NAME.test(task)) {
      const base = { repo, mission: mission.id, task, path: w.path };
      report.adopted.push(w.branch ? { ...base, kind: 'branch', branch: branchName(mission.id, task) } : { ...base, kind: 'lens' });
    }
  }
  for (const entry of await readdir(dir)) {
    const at = path.join(dir, entry);
    if (!NAME.test(entry) || ours.some((w) => w.path === at)) continue;
    const to = await quarantine(at);
    if (to) report.quarantined.push(to);
  }
  return report;
}
