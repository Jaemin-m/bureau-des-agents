// 책상 사이 길 찾기(A*, 네 방향, 픽셀 아트 게임처럼).

export type Tile = [number, number];

export function findPath(grid: boolean[][], from: Tile, to: Tile): Tile[] | null {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  const key = (x: number, y: number) => y * cols + x;
  const ok = (x: number, y: number) => x >= 0 && y >= 0 && x < cols && y < rows && (grid[y][x] || (x === to[0] && y === to[1]));
  if (from[0] === to[0] && from[1] === to[1]) return [to];
  const open = new Map<number, { x: number; y: number; g: number; f: number }>();
  const came = new Map<number, number>();
  const gScore = new Map<number, number>();
  const h = (x: number, y: number) => Math.abs(x - to[0]) + Math.abs(y - to[1]);
  const s = key(from[0], from[1]);
  open.set(s, { x: from[0], y: from[1], g: 0, f: h(from[0], from[1]) });
  gScore.set(s, 0);
  const closed = new Set<number>();
  let guard = 0;
  while (open.size && guard++ < 4000) {
    let best: { x: number; y: number; g: number; f: number } | null = null;
    let bestK = -1;
    for (const [k, n] of open) if (!best || n.f < best.f || (n.f === best.f && n.g > best.g)) { best = n; bestK = k; }
    if (!best) break;
    open.delete(bestK);
    closed.add(bestK);
    if (best.x === to[0] && best.y === to[1]) {
      const out: Tile[] = [[best.x, best.y]];
      let k = bestK;
      while (came.has(k)) {
        k = came.get(k)!;
        out.push([k % cols, Math.floor(k / cols)]);
      }
      out.reverse();
      return out.slice(1);
    }
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = best.x + dx;
      const ny = best.y + dy;
      if (!ok(nx, ny)) continue;
      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      // 직진에 작은 보너스: 지그재그가 줄어든다
      const turn = came.has(bestK) ? (() => { const p = came.get(bestK)!; const px = p % cols, py = Math.floor(p / cols); return (best.x - px === dx && best.y - py === dy) ? 0 : 0.2; })() : 0;
      const g = best.g + 1 + turn;
      if (g < (gScore.get(nk) ?? Infinity)) {
        gScore.set(nk, g);
        came.set(nk, bestK);
        open.set(nk, { x: nx, y: ny, g, f: g + h(nx, ny) });
      }
    }
  }
  return null;
}
