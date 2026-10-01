import type { ClaimStatus, GraphValue } from './types';
import type { SourceGraph } from './source';

/** Portable parser output; entity IDs and source revisions are assigned on commit. */
export interface PreparedSourceClaim {
  predicate: string;
  value: GraphValue;
  chunkIndex: number;
  status: ClaimStatus;
  method: string;
  model?: string;
}

export function commitPreparedClaims(graph: SourceGraph, subject: number,
  claims: PreparedSourceClaim[], chunkOffset = 0): void {
  for (const claim of claims) graph.claim(subject,claim.predicate,{value:claim.value}, {
    status:claim.status,method:claim.method,model:claim.model,
    evidence:[...graph.evidence(undefined,undefined,claim.method),
      ...graph.evidence(claim.chunkIndex + chunkOffset,undefined,claim.method,'mentions')],
  });
}
