import type { Database } from 'bun:sqlite';
import type { GraphIngestor } from '../graph';
import type { ClaimInput, EvidenceInput } from '../graph/types';
import { mutationSchemas, type MutationName } from './schemas';
import { checkVersion, recordVersion } from './version';
import { resolveEntityReference } from './entity-reference';
import { activeEvidence } from './active-evidence';
import { projectEventReplacement } from './event-projection';

export function reviseClaim(db: Database, graph: GraphIngestor, claimId: string, patch: Record<string,unknown>, actor: string, reason: string,
  refs: Record<string,number>,syncProjections=true) {
  const old = graph.claims.get(claimId);
  if(!Object.keys(patch).length) throw new Error('Provide claim fields to revise');
  if(patch.object!==undefined && patch.object!==null && Object.hasOwn(patch,'value')) throw new Error('Provide an object or literal value, not both');
  if (old.status === 'superseded' || old.status === 'retracted') throw new Error('Cannot revise an inactive claim; revise its active replacement');
  const {id:_id,recordedAt:_recorded,version:_version,...base} = old;
  const input = {...base,...patch} as unknown as ClaimInput;
  // Omission inherits; explicit null clears optional fields.
  for (const field of ['object','datatype','unit','language','validFrom','validTo','confidence'] as const)
    if (patch[field] === null) delete input[field];
  if (patch.object !== undefined && patch.object !== null) delete input.value;
  if (Object.hasOwn(patch,'value')) delete input.object;
  input.subject = resolveEntityReference(graph,input.subject,refs);
  if (input.object !== undefined) input.object = resolveEntityReference(graph,input.object,refs);
  input.evidence = Object.hasOwn(patch,'evidence') ? patch.evidence as EvidenceInput[] : activeEvidence(db,graph,claimId);
  input.dependsOn = Object.hasOwn(patch,'dependsOn') ? patch.dependsOn as string[] :
    db.query<{depends_on:string}, [string]>('SELECT depends_on FROM graph_dependencies WHERE claim_id=?').all(claimId).map(r=>r.depends_on);
  if (input.dependsOn.includes(claimId)) throw new Error('Replacement cannot depend on its superseded predecessor');
  if (!Object.hasOwn(patch,'status') && !['accepted','proposed'].includes(old.status)) input.status='proposed';
  graph.lifecycle.review(claimId,'superseded',actor,reason);
  const claim = graph.claims.add(input);
  db.query("INSERT INTO graph_claim_links VALUES(?,?,'supersedes')").run(claim.id,claimId);
  if(syncProjections) projectEventReplacement(db,graph,claimId,claim);
  return {claim,previousClaimId:claimId,version:recordVersion(db,'claim',claim.id)};
}

export type ClaimRevision = (claimId: string, patch: Record<string,unknown>, actor: string, reason: string, refs: Record<string,number>) => ReturnType<typeof reviseClaim>;

export function executeClaimEdit(db: Database, graph: GraphIngestor, name: MutationName, raw: Record<string,unknown>, actor: string, reason: string, refs: Record<string,number>): unknown {
  switch(name) {
    case 'connect_entities': {
      const a=mutationSchemas[name].parse(raw);
      if(a.object===undefined || a.value!==undefined) throw new Error('A connection requires an object entity and no literal value');
      return graph.claims.add({...a,subject:resolveEntityReference(graph,a.subject,refs),object:resolveEntityReference(graph,a.object,refs)});
    }
    case 'revise_connection':
    case 'revise_claim': {
      const a=mutationSchemas[name].parse(raw);checkVersion(db,'claim',a.claimId,a.expectedVersion);
      if(name==='revise_connection' && graph.claims.get(a.claimId).object===undefined) throw new Error('Claim is not a connection');
      const result=reviseClaim(db,graph,a.claimId,a.patch,actor,reason,refs);
      if(name==='revise_connection' && result.claim.object===undefined) throw new Error('Connection replacement must have an object entity');
      return result;
    }
    case 'retract_connection': {
      const a=mutationSchemas[name].parse(raw);checkVersion(db,'claim',a.claimId,a.expectedVersion);
      if(graph.claims.get(a.claimId).object===undefined) throw new Error('Claim is not a connection');
      const claim=graph.lifecycle.review(a.claimId,'retracted',actor,reason);
      db.query('DELETE FROM graph_participants WHERE claim_id=?').run(a.claimId);
      return claim;
    }
    case 'batch_review_claims': {
      const a=mutationSchemas[name].parse(raw);
      return a.claims.map(c=>{checkVersion(db,'claim',c.claimId,c.expectedVersion);return graph.lifecycle.review(c.claimId,c.status,actor,reason);});
    }
    case 'unlink_claims': {
      const a=mutationSchemas[name].parse(raw);checkVersion(db,'claim',a.from,a.expectedVersion);
      graph.claims.get(a.from);graph.claims.get(a.to);
      const result=db.query('DELETE FROM graph_claim_links WHERE source_id=? AND target_id=? AND relation=?').run(a.from,a.to,a.relation);
      if(!result.changes) throw new Error('Claim link does not exist');
      db.query('UPDATE graph_claims SET id=id WHERE id=?').run(a.from);
      return {removed:true,target:graph.claims.get(a.to),requiresReview:a.relation==='supersedes'};
    }
    case 'add_claim_dependency':
    case 'remove_claim_dependency': {
      const a=mutationSchemas[name].parse(raw);checkVersion(db,'claim',a.claimId,a.expectedVersion);
      const claim=graph.claims.get(a.claimId),parent=graph.claims.get(a.dependsOn);
      if(name==='add_claim_dependency') {
        if(['rejected','superseded','stale','retracted','disputed'].includes(parent.status) || (claim.status==='accepted' && parent.status!=='accepted'))
          throw new Error('Dependency must be active; accepted conclusions require accepted parents');
        if(a.claimId===a.dependsOn || db.query(`WITH RECURSIVE ancestors(id) AS (
          SELECT depends_on FROM graph_dependencies WHERE claim_id=? UNION
          SELECT d.depends_on FROM graph_dependencies d JOIN ancestors a ON d.claim_id=a.id)
          SELECT 1 FROM ancestors WHERE id=?`).get(a.dependsOn,a.claimId)) throw new Error('Dependency would create a cycle');
        db.query('INSERT INTO graph_dependencies VALUES(?,?)').run(a.claimId,a.dependsOn);
        db.query('UPDATE graph_claims SET id=id WHERE id=?').run(a.claimId);
      } else {
        if(!db.query('DELETE FROM graph_dependencies WHERE claim_id=? AND depends_on=?').run(a.claimId,a.dependsOn).changes) throw new Error('Dependency does not exist');
        graph.lifecycle.review(a.claimId,'stale',actor,reason);
      }
      return graph.inspect(a.claimId);
    }
    default: throw new Error(`Unsupported graph mutation ${name}`);
  }
}
