/**
 * Maximum-weight bipartite assignment (Kuhn–Munkres, O(n²m) with potentials; Jonker–Volgenant style
 * shortest augmenting paths). Rows and columns may differ in number; a pair with weight ≤ 0 is never
 * reported as matched, so "no overlap" stays unassigned instead of being forced onto something.
 *
 * Used to keep episode ids stable across reclusterings: rows are new clusters, columns existing episodes,
 * weights their member overlap. Pure; deterministic for a given matrix.
 */
export function hungarian(weights: number[][]): Array<[row: number, column: number]> {
  const rows = weights.length, columns = rows ? Math.max(...weights.map(row => row.length)) : 0;
  if (!rows || !columns) return [];
  // Square cost matrix of size N (padding with 0), minimise cost = max − weight.
  const n = Math.max(rows, columns);
  let max = 0;
  for (const row of weights) for (const w of row) if (w > max) max = w;
  const cost = (i: number, j: number) => max - (i < rows && j < columns ? Math.max(0, weights[i]![j] ?? 0) : 0);
  const u = new Float64Array(n + 1), v = new Float64Array(n + 1);
  const p = new Int32Array(n + 1), way = new Int32Array(n + 1); // p[j]: row matched to column j (1-based)
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Float64Array(n + 1).fill(Infinity), used = new Uint8Array(n + 1);
    do {
      used[j0] = 1;
      const i0 = p[j0]!;
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const current = cost(i0 - 1, j - 1) - u[i0]! - v[j]!;
        if (current < minv[j]!) { minv[j] = current; way[j] = j0; }
        if (minv[j]! < delta) { delta = minv[j]!; j1 = j; }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]!]! += delta; v[j]! -= delta; } else minv[j]! -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]!; p[j0] = p[j1]!; j0 = j1; } while (j0);
  }
  const out: Array<[number, number]> = [];
  for (let j = 1; j <= n; j++) {
    const i = p[j]! - 1, column = j - 1;
    if (i < rows && column < columns && (weights[i]![column] ?? 0) > 0) out.push([i, column]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}
