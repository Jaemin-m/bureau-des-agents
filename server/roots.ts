import { realpath } from 'node:fs/promises';
import path from 'node:path';

/** Both paths must already be real paths. True only when `child` is strictly below `parent`. */
export function contains(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

export async function realOrNull(p: string): Promise<string | null> {
  try { return await realpath(p); } catch { return null; }
}

/** The real path of `requested` if it exists strictly inside one of `roots` after following every symlink, else null. */
export async function resolveInside(roots: readonly string[], requested: string): Promise<string | null> {
  if (requested.includes('\0')) return null;
  for (const root of roots) {
    const rootReal = await realOrNull(root);
    if (!rootReal) continue;
    const real = await realOrNull(path.resolve(rootReal, requested));
    if (real && contains(rootReal, real)) return real;
  }
  return null;
}
