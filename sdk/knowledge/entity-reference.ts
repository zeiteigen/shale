import type { GraphIngestor } from '../graph';

export function resolveEntityReference(graph: GraphIngestor, reference: number | string, refs: Record<string,number> = {}): number {
  if (typeof reference === 'number') return graph.entities.get(reference).id;
  if (reference.startsWith('@')) {
    const id = refs[reference.slice(1)];
    if (id === undefined) throw new Error(`Unknown local entity reference ${reference}`);
    return id;
  }
  const matches = graph.entities.resolve(reference);
  if (matches.length !== 1) throw new Error(`Entity ${reference} resolves to ${matches.length} nodes; specify an ID`);
  return matches[0]!.id;
}

