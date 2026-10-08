import type { Database } from 'bun:sqlite';
import type { GraphIngestor } from '../graph';
import type { Evidence, EvidenceInput } from '../graph/types';

/** Copy citation fields without reusing the original evidence ID. */
export function cloneEvidenceInput(evidence: Evidence): EvidenceInput {
  return {
    revisionId:evidence.revisionId,sourceId:evidence.sourceId,chunkIndex:evidence.chunkIndex,stance:evidence.stance,
    quote:evidence.quote,locator:evidence.locator,method:evidence.method,model:evidence.model,confidence:evidence.confidence,
  };
}

export function activeEvidence(db: Database, graph: GraphIngestor, claimId: string): EvidenceInput[] {
  return graph.evidence.list(claimId).filter(e=>e.withdrawnAt===undefined).map(cloneEvidenceInput);
}
