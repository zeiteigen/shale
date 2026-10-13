import type { GraphData } from './types';

export function graphAdjacency(data: GraphData) {
  const adjacency = new Map<number, number[]>();
  for (const edge of data.edges) for (const [from, to] of [[edge.source, edge.target], [edge.target, edge.source]]) {
    const neighbors = adjacency.get(from) ?? [];
    if (!adjacency.has(from)) adjacency.set(from, neighbors);
    neighbors.push(to);
  }
  return adjacency;
}

export function visibleGraph(data: GraphData, adjacency: Map<number, number[]>, types: Set<string>, selected: number | undefined, focus: boolean, depth: number) {
  let included: Set<number> | undefined;
  if (focus && selected !== undefined) {
    included = new Set([selected]);
    let frontier = [selected];
    for (let degree = 0; degree < depth; degree++) {
      const next: number[] = [];
      for (const id of frontier) for (const neighbor of adjacency.get(id) ?? []) if (!included.has(neighbor)) {
        included.add(neighbor);
        next.push(neighbor);
      }
      frontier = next;
    }
  }
  const nodes = data.nodes.filter(node => (!included || included.has(node.id)) && (types.has(node.type) || included && node.id === selected));
  const ids = new Set(nodes.map(node => node.id));
  return { nodes, edges: data.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target)) };
}
