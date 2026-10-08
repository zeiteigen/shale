import type { Database } from 'bun:sqlite';
import type { GraphIngestor } from '../graph';
import type { MutationName } from './schemas';
import { resolveEntityReference } from './entity-reference';
import { executeClaimEdit, reviseClaim } from './claim-edits';
import { executeEntityEdit } from './entity-edits';
import { executeEvidenceEdit } from './evidence-edits';
import { reviseEvent } from './event-edits';

export class KnowledgeGraphEdits {
  constructor(private db: Database, private graph: GraphIngestor) {}

  resolve(reference: number | string, refs: Record<string,number> = {}): number {
    return resolveEntityReference(this.graph,reference,refs);
  }

  execute(name: MutationName, raw: Record<string,unknown>, actor: string, reason: string, refs: Record<string,number>): unknown {
    const revise = (id: string, patch: Record<string,unknown>, actor: string, reason: string, refs: Record<string,number>) =>
      reviseClaim(this.db,this.graph,id,patch,actor,reason,refs);
    switch(name) {
      case 'update_entity':
      case 'remove_entity_alias':
      case 'split_entity':
      case 'append_graph':
        return executeEntityEdit(this.db,this.graph,revise,name,raw,actor,reason,refs);
      case 'connect_entities':
      case 'revise_connection':
      case 'revise_claim':
      case 'retract_connection':
      case 'batch_review_claims':
      case 'unlink_claims':
      case 'add_claim_dependency':
      case 'remove_claim_dependency':
        return executeClaimEdit(this.db,this.graph,name,raw,actor,reason,refs);
      case 'revise_evidence':
      case 'retract_evidence':
        return executeEvidenceEdit(this.db,this.graph,name,raw,actor,reason);
      case 'revise_event':
        return reviseEvent(this.db,this.graph,(id,patch,actor,reason,refs)=>reviseClaim(this.db,this.graph,id,patch,actor,reason,refs,false),raw,actor,reason,refs);
      default: throw new Error(`Unsupported graph mutation ${name}`);
    }
  }
}
