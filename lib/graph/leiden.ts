/**
 * Constrained Leiden community detection with the Constant Potts Model (Traag, Waltman & van Eck 2019).
 *
 * Quality: H = Σ_c [ w_in(c) − γ · n_c(n_c − 1)/2 ], where n_c sums node sizes. Unlike modularity, CPM has no
 * resolution limit and γ reads directly in edge-weight units: two groups merge when the weight between them
 * exceeds γ per pair of members. That replaces hand-tuned attach/review score bands with one parameter.
 *
 * Constraints: must-links are contracted into one node before clustering (so they can never separate);
 * cannot-links are checked on every move, in refinement, and survive aggregation, so no community ever holds
 * both ends of one. Contraction skips a must-link that would join a cannot-linked pair: an explicit user
 * separation outranks structural evidence.
 *
 * Deterministic: node visiting order comes from a seeded PRNG, and refinement merges greedily (Leiden's
 * randomised refinement with θ → 0), so the same graph and seed always give the same partition.
 * Pure: no database access; ~3k nodes run in milliseconds.
 */
/** `evidence`: how many independent pieces of evidence the weight sums (informational; ignored by clustering). */
export interface Edge { a: number; b: number; w: number; evidence?: number }
export interface LeidenOptions {
  /** CPM resolution γ, in edge-weight units per pair of nodes. */
  resolution: number;
  seed?: number;
  /** Outer iterations (local moving → refinement → aggregation) at most. */
  iterations?: number;
  must?: Array<[number, number]>;
  cannot?: Array<[number, number]>;
}

/** mulberry32: small, fast, seedable. */
export function prng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(n: number, random: () => number): number[] {
  const order = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j]!, order[i]!]; }
  return order;
}

/** Union-find over n items. */
export class UnionFind {
  readonly parent: number[];
  constructor(n: number) { this.parent = Array.from({ length: n }, (_, i) => i); }
  find(x: number): number {
    while (this.parent[x] !== x) { this.parent[x] = this.parent[this.parent[x]!]!; x = this.parent[x]!; }
    return x;
  }
  union(a: number, b: number) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb); return ra !== rb; }
}

/** Weighted graph in adjacency form; `size` is each node's weight in the CPM penalty, `conflict` its cannot-links. */
interface Graph { n: number; adj: Array<Map<number, number>>; size: number[]; self: number[]; conflict: Array<Set<number>> }

function build(n: number, edges: Edge[], size: number[], conflicts: Array<[number, number]>): Graph {
  const adj = Array.from({ length: n }, () => new Map<number, number>()), self = new Array<number>(n).fill(0);
  for (const { a, b, w } of edges) {
    if (!(w > 0)) continue;
    if (a === b) { self[a]! += w; continue; }
    adj[a]!.set(b, (adj[a]!.get(b) ?? 0) + w);
    adj[b]!.set(a, (adj[b]!.get(a) ?? 0) + w);
  }
  const conflict = Array.from({ length: n }, () => new Set<number>());
  for (const [a, b] of conflicts) if (a !== b) { conflict[a]!.add(b); conflict[b]!.add(a); }
  return { n, adj, size, self, conflict };
}

/** Community bookkeeping shared by local moving and refinement. */
class Partition {
  readonly of: number[];
  readonly total: number[];
  constructor(readonly graph: Graph, initial?: number[]) {
    this.of = initial ? [...initial] : Array.from({ length: graph.n }, (_, i) => i);
    this.total = new Array<number>(graph.n).fill(0);
    for (let v = 0; v < graph.n; v++) this.total[this.of[v]!]! += graph.size[v]!;
  }
  /** Whether v may join community c: none of its cannot-linked nodes are there. */
  allowed(v: number, c: number) {
    for (const u of this.graph.conflict[v]!) if (u !== v && this.of[u] === c) return false;
    return true;
  }
  /** Edge weight from v to each neighbouring community. */
  links(v: number, within?: (u: number) => boolean) {
    const out = new Map<number, number>();
    for (const [u, w] of this.graph.adj[v]!) if (!within || within(u)) out.set(this.of[u]!, (out.get(this.of[u]!) ?? 0) + w);
    return out;
  }
  move(v: number, c: number) { this.total[this.of[v]!]! -= this.graph.size[v]!; this.of[v] = c; this.total[c]! += this.graph.size[v]!; }
}

/** An empty community id (one exists: there are as many ids as nodes). */
function emptyCommunity(p: Partition, hint: number) {
  if (p.total[hint] === 0) return hint;
  for (let c = 0; c < p.graph.n; c++) if (p.total[c] === 0) return c;
  return -1;
}

/** Leiden's fast local moving: revisit only neighbours of moved nodes. Returns whether anything moved. */
function moveNodes(p: Partition, gamma: number, random: () => number): boolean {
  const { graph } = p;
  const queue = shuffled(graph.n, random), queued = new Uint8Array(graph.n).fill(1);
  let moved = false;
  for (let head = 0; head < queue.length; head++) {
    const v = queue[head]!; queued[v] = 0;
    const own = p.of[v]!, sv = graph.size[v]!, links = p.links(v);
    const stay = (links.get(own) ?? 0) - gamma * sv * (p.total[own]! - sv);
    let best = own, bestGain = 0;
    for (const [c, w] of links) {
      if (c === own || !p.allowed(v, c)) continue;
      const gain = w - gamma * sv * p.total[c]! - stay;
      if (gain > bestGain + 1e-12 || (Math.abs(gain - bestGain) <= 1e-12 && gain > 0 && c < best)) { best = c; bestGain = gain; }
    }
    // Leaving for an empty community gains −stay.
    if (-stay > bestGain + 1e-12 && p.total[own]! > sv) {
      const empty = emptyCommunity(p, v);
      if (empty >= 0) { best = empty; bestGain = -stay; }
    }
    if (best === own) continue;
    p.move(v, best); moved = true;
    for (const u of graph.adj[v]!.keys()) if (!queued[u] && p.of[u] !== best) { queued[u] = 1; queue.push(u); }
  }
  return moved;
}

/**
 * Refinement: inside each community, start from singletons and greedily merge well-connected nodes into
 * well-connected sub-communities. Guarantees every final community is connected (Louvain does not).
 */
function refine(graph: Graph, coarse: number[], gamma: number, random: () => number): number[] {
  const p = new Partition(graph);
  const inside = new Map<number, number>(); // node → weight to the rest of its coarse community
  const coarseTotal = new Map<number, number>();
  for (let v = 0; v < graph.n; v++) coarseTotal.set(coarse[v]!, (coarseTotal.get(coarse[v]!) ?? 0) + graph.size[v]!);
  for (let v = 0; v < graph.n; v++) {
    let w = 0;
    for (const [u, weight] of graph.adj[v]!) if (coarse[u] === coarse[v]) w += weight;
    inside.set(v, w);
  }
  // External weight of each refined community to the rest of its coarse community (starts as the node's own).
  const external = new Map<number, number>([...inside]);
  const singleton = new Uint8Array(graph.n).fill(1);
  for (const v of shuffled(graph.n, random)) {
    if (!singleton[v]) continue;
    const C = coarse[v]!, nC = coarseTotal.get(C)!, sv = graph.size[v]!;
    if (inside.get(v)! < gamma * sv * (nC - sv)) continue; // v is not well connected to its community
    const links = p.links(v, u => coarse[u] === C);
    let best = p.of[v]!, bestGain = 0;
    for (const [c, w] of links) {
      if (c === p.of[v] || !p.allowed(v, c)) continue;
      const nT = p.total[c]!;
      if (external.get(c)! < gamma * nT * (nC - nT)) continue; // target not well connected
      const gain = w - gamma * sv * nT;
      if (gain > bestGain + 1e-12 || (Math.abs(gain - bestGain) <= 1e-12 && gain >= 0 && c < best)) { best = c; bestGain = gain; }
    }
    if (best === p.of[v]) continue;
    const own = p.of[v]!;
    // External weight of the merged community: both sides' external weight minus the links now internal (counted twice).
    external.set(best, external.get(best)! + external.get(own)! - 2 * (links.get(best) ?? 0));
    external.delete(own);
    p.move(v, best);
    singleton[v] = 0;
    for (let u = 0; u < graph.n; u++) if (p.of[u] === best) singleton[u] = 0;
  }
  return p.of;
}

/** Collapse each refined community into one node; edges sum, sizes add, cannot-links carry over. */
function aggregate(graph: Graph, refined: number[]) {
  const ids = new Map<number, number>();
  for (const c of refined) if (!ids.has(c)) ids.set(c, ids.size);
  const n = ids.size, size = new Array<number>(n).fill(0), self = new Array<number>(n).fill(0);
  const adj = Array.from({ length: n }, () => new Map<number, number>());
  const conflict = Array.from({ length: n }, () => new Set<number>());
  for (let v = 0; v < graph.n; v++) {
    const a = ids.get(refined[v]!)!;
    size[a]! += graph.size[v]!; self[a]! += graph.self[v]!;
    for (const [u, w] of graph.adj[v]!) {
      const b = ids.get(refined[u]!)!;
      if (a === b) { if (v < u) self[a]! += w; } else adj[a]!.set(b, (adj[a]!.get(b) ?? 0) + w);
    }
    for (const u of graph.conflict[v]!) { const b = ids.get(refined[u]!)!; if (a !== b) conflict[a]!.add(b); }
  }
  return { graph: { n, adj, size, self, conflict } as Graph, map: refined.map(c => ids.get(c)!) };
}

/** Constant Potts Model quality of a partition (for tests and diagnostics). */
export function cpmQuality(n: number, edges: Edge[], community: number[], gamma: number, size?: number[]) {
  let q = 0;
  for (const { a, b, w } of edges) if (community[a] === community[b]) q += w;
  const totals = new Map<number, number>();
  for (let v = 0; v < n; v++) totals.set(community[v]!, (totals.get(community[v]!) ?? 0) + (size?.[v] ?? 1));
  for (const t of totals.values()) q -= gamma * t * (t - 1) / 2;
  return q;
}

/**
 * Must-link components: node → component index (0..k−1, in order of first node). A must-link that would
 * put a cannot-linked pair into one component is skipped.
 */
export function contract(n: number, must: Array<[number, number]>, cannot: Array<[number, number]>): number[] {
  const uf = new UnionFind(n);
  const partners = new Map<number, number[]>();
  for (const [a, b] of cannot) { (partners.get(a) ?? partners.set(a, []).get(a)!).push(b); (partners.get(b) ?? partners.set(b, []).get(b)!).push(a); }
  const members = new Map<number, number[]>(); // root → nodes, kept for the conflict check
  const of = (r: number) => members.get(r) ?? [r];
  for (const [a, b] of must) {
    const ra = uf.find(a), rb = uf.find(b);
    if (ra === rb) continue;
    const side = new Set(of(rb));
    if (of(ra).some(x => (partners.get(x) ?? []).some(y => side.has(y)))) continue;
    uf.union(ra, rb);
    members.set(uf.find(ra), [...of(ra), ...of(rb)]);
  }
  const roots = new Map<number, number>();
  return Array.from({ length: n }, (_, v) => { const r = uf.find(v); if (!roots.has(r)) roots.set(r, roots.size); return roots.get(r)!; });
}

/**
 * Cluster nodes 0..n−1. Returns a community label per node, renumbered 0..k−1 in order of first node.
 * Must-links are contracted first, so a must-linked pair always shares a label; a cannot-linked pair never does.
 */
export function leiden(n: number, edges: Edge[], options: LeidenOptions): number[] {
  const gamma = options.resolution, random = prng(options.seed ?? 42);
  const cannot = options.cannot ?? [];
  const node = contract(n, options.must ?? [], cannot);
  const roots = new Set(node);
  const size = new Array<number>(roots.size).fill(0);
  for (let v = 0; v < n; v++) size[node[v]!]! += 1;
  let graph = build(roots.size, edges.map(e => ({ a: node[e.a]!, b: node[e.b]!, w: e.w })), size,
    cannot.map(([a, b]) => [node[a]!, node[b]!] as [number, number]).filter(([a, b]) => a !== b));
  // levels[k][i]: level-k node i → level-(k+1) node.
  const levels: number[][] = [];
  let partition = new Partition(graph);
  for (let iteration = 0; iteration < (options.iterations ?? 20); iteration++) {
    moveNodes(partition, gamma, random);
    if (new Set(partition.of).size === graph.n) break; // every node alone: nothing left to aggregate
    const refined = refine(graph, partition.of, gamma, random);
    if (new Set(refined).size === graph.n) break; // refinement merged nothing: aggregating would not change the graph
    const { graph: next, map } = aggregate(graph, refined);
    // Each aggregate node starts in the coarse community of its members.
    const initial = new Array<number>(next.n);
    for (let v = 0; v < graph.n; v++) initial[map[v]!] = partition.of[v]!;
    const relabel = new Map<number, number>();
    for (let i = 0; i < next.n; i++) { if (!relabel.has(initial[i]!)) relabel.set(initial[i]!, relabel.size); initial[i] = relabel.get(initial[i]!)!; }
    levels.push(map);
    graph = next;
    partition = new Partition(graph, initial);
  }
  // Project the final partition back through every level and the must-link contraction.
  let label = partition.of;
  for (let k = levels.length - 1; k >= 0; k--) { const map = levels[k]!; label = map.map(i => label[i]!); }
  const out = new Map<number, number>();
  return node.map(i => { const c = label[i]!; if (!out.has(c)) out.set(c, out.size); return out.get(c)!; });
}
