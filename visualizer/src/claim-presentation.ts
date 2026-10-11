import type { Claim, GraphValue } from '../../sdk/graph/types';
import type { GraphNode } from './types';

export function claimPredicate(claim: Claim) {
  const label = claim.predicate.replace(/^PROPERTY:/, '').replaceAll('_', ' ').toLowerCase();
  return `${claim.polarity === -1 ? 'Does not: ' : ''}${label}`;
}

function valueLabel(value: GraphValue | undefined): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(valueLabel).join(', ');
  return value === undefined ? 'No value recorded' : typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
}

/** Incoming assertions name their subject, rather than repeating the selected node. */
export function claimTarget(claim: Claim, selectedId: number, nodes: GraphNode[]) {
  if (claim.object === undefined) return `${valueLabel(claim.value)}${claim.unit ? ` ${claim.unit}` : ''}`;
  const id = claim.object === selectedId ? claim.subject : claim.object;
  return nodes.find(node => node.id === id)?.name ?? `Entry ${id}`;
}
