import type { Database } from 'bun:sqlite';
import type { GraphIngestor } from '../graph';
import type { EvidenceInput } from '../graph/types';
import { mutationSchemas, type MutationName } from './schemas';
import { checkVersion } from './version';
import { cloneEvidenceInput } from './active-evidence';

export function executeEvidenceEdit(db: Database, graph: GraphIngestor, name: MutationName, raw: Record<string,unknown>, actor: string, reason: string): unknown {
  switch(name) {
    case 'revise_evidence':
    case 'retract_evidence': {
      const a=mutationSchemas[name].parse(raw);checkVersion(db,'evidence',a.evidenceId,a.expectedVersion);
      const row=db.query<{claim_id:string}, [string]>('SELECT claim_id FROM graph_evidence WHERE id=?').get(a.evidenceId);
      if(!row || db.query('SELECT 1 FROM graph_evidence_history WHERE evidence_id=?').get(a.evidenceId)) throw new Error('Unknown or withdrawn evidence');
      const old=graph.evidence.list(row.claim_id).find(e=>e.id===a.evidenceId)!;
      let replacementId:string|undefined;
      if(name==='revise_evidence') {
        const patch=mutationSchemas.revise_evidence.parse(raw).patch;
        if(!Object.keys(patch).length) throw new Error('Provide citation fields to revise');
        const input={...cloneEvidenceInput(old),...patch} as EvidenceInput;
        for(const field of ['sourceId','revisionId','chunkIndex','quote','locator','confidence','model'] as const)
          if(patch[field]===null) delete input[field];
        if(patch.sourceId!==undefined && patch.sourceId!==null && patch.revisionId===undefined) delete input.revisionId;
        replacementId=graph.evidence.add(row.claim_id,input);
      }
      db.query('INSERT INTO graph_evidence_history VALUES(?,?,?,?,?)').run(a.evidenceId,replacementId ?? null,actor,reason,Date.now());
      db.query("UPDATE graph_record_versions SET version=version+1 WHERE kind='evidence' AND record_id=?").run(a.evidenceId);
      if(old.stance==='supports' && ['accepted','proposed','disputed'].includes(graph.claims.get(row.claim_id).status))
        graph.lifecycle.review(row.claim_id,'stale',actor,reason);
      return {evidenceId:a.evidenceId,replacementId,claim:graph.claims.get(row.claim_id),requiresReview:true};
    }
    default: throw new Error(`Unsupported graph mutation ${name}`);
  }
}
