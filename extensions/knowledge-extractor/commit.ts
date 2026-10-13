import { createHash } from 'node:crypto';
import type { ShaleSDK } from '@shale/sdk';
import type { ExtractionCheckpoint } from './types';
import { groundEvidence } from './evidence';
import { extractionCursorKey } from './source-window';
import { validateTemporalEvidence } from './temporal-evidence';
import { IdentityResolver } from '../../sdk/graph/identity';
import { ensureStorySchema } from '../../lib/graph/story-schema';
import type { ExtractedEntity } from './types';
import { consistentDatatype } from './claim-datatype';
export { consistentDatatype } from './claim-datatype';

/** An entity is grounded when its name or an alias occurs in the supplied text, or it matched a listed entity. */
function grounded(entity: ExtractedEntity, text: string) {
  const lower = text.toLowerCase();
  return entity.match != null || [entity.name, ...(entity.aliases ?? [])].some(name => name.trim().length > 1 && lower.includes(name.trim().toLowerCase()));
}

function recordDigest(sdk: ShaleSDK, data: ExtractionCheckpoint, entityIds: number[]) {
  const source = sdk.database.query<{ created_at: number; updated_at: number }, [string]>(
    'SELECT created_at,updated_at FROM sources WHERE id=?').get(data.sourceId);
  const existing = sdk.database.query<{ revision_id: number; entity_ids: string }, [string]>(
    'SELECT revision_id,entity_ids FROM graph_source_digests WHERE source_id=?').get(data.sourceId);
  const { summary } = data.extraction;
  // The connector knows who took part; the model may not promote the user into someone else's conversation.
  const involvement = data.digest?.userAbsent && ['participant', 'author'].includes(data.extraction.involvement ?? '')
    ? 'observer' : data.extraction.involvement;
  // Other people's conversations can provide episode context, but cannot establish a pursuit of the user's.
  const activity = data.digest?.userAbsent ? null : data.extraction.activity;
  if (data.first !== false) {
    sdk.database.query(`INSERT INTO graph_source_digests(source_id,revision_id,digested_at,summary,involvement,activity,entity_ids,
      occurred_from,occurred_to,model,episode_state) VALUES(?,?,?,?,?,?,?,?,?,?,'pending')
      ON CONFLICT(source_id) DO UPDATE SET revision_id=excluded.revision_id,digested_at=excluded.digested_at,summary=excluded.summary,
      involvement=excluded.involvement,activity=excluded.activity,entity_ids=excluded.entity_ids,occurred_from=excluded.occurred_from,
      occurred_to=excluded.occurred_to,model=excluded.model,episode_state='pending',signals_at=NULL,episode_checked_at=NULL`)
      .run(data.sourceId, data.revisionId, Date.now(), summary ?? '', involvement ?? 'none', activity ? JSON.stringify(activity) : null,
        JSON.stringify([...new Set(entityIds)]), source?.created_at ?? null, source?.updated_at ?? null, data.model ?? null);
    sdk.database.query('DELETE FROM graph_digest_signals WHERE source_id=?').run(data.sourceId);
  } else if (existing?.revision_id === data.revisionId) {
    const merged = [...new Set([...JSON.parse(existing.entity_ids) as number[], ...entityIds])];
    // Later windows can expose the entities that connect this source to a story.
    // Reconsider earlier decisions after its evidence changes, including a prior "none".
    sdk.database.query("UPDATE graph_source_digests SET entity_ids=?,signals_at=NULL,episode_state='pending',episode_checked_at=NULL WHERE source_id=?")
      .run(JSON.stringify(merged), data.sourceId);
    sdk.database.query('DELETE FROM graph_digest_signals WHERE source_id=?').run(data.sourceId);
  }
}

/** Resolve checkpoints and progress in the same transaction as graph writes. */
export function commitExtractions(sdk: ShaleSDK) {
  ensureStorySchema(sdk.database);
  return sdk.database.transaction(()=> {
    let committed=0;
    for (const cp of sdk.checkpoint.getQueue<ExtractionCheckpoint>()) {
      if (!cp.id.startsWith('knowledge-extraction:') || cp.data.type!=='knowledge-extraction') continue;
      const data=cp.data;
      validateTemporalEvidence(data);
      const ids=new Map<string,number>();
      for (const entity of data.extraction.entities) {
        const stableId=`extracted:${createHash('sha256').update(JSON.stringify([data.namespace,data.sourceId,entity.type,entity.name])).digest('hex')}`;
        const node=sdk.graph.entities.create({stableId,name:entity.name,type:entity.type,namespace:data.namespace,
          aliases:entity.aliases?.map(name=>({name,scope:`source:${data.sourceId}`}))});
        ids.set(entity.key,node.id);
      }
      // Connector identity aliases bridge the document and its extracted entities.
      const sourceEntities = sdk.graph.entities.resolve(data.sourceId,'source-id');
      const text = data.chunks.map(chunk=>chunk.text_content).join('\n');
      const resolver = new IdentityResolver(sdk.database, sdk.graph);
      const canonical: number[] = [];
      for (const entity of data.extraction.entities) {
        const id = ids.get(entity.key)!;
        const supporting = data.extraction.claims.find(claim=>claim.subject===entity.key || claim.object===entity.key)?.evidence
          ?? data.extraction.events.find(event=>event.participants.some(p=>p.entity===entity.key))?.evidence;
        if (!supporting && !grounded(entity, text)) continue;
        for (const key of entity.searchKeys ?? []) sdk.graph.entities.addAlias(id,key,'search');
        if (entity.description && !sdk.database.query('SELECT 1 FROM graph_claims WHERE id=?').get(`${cp.id}:description:${entity.key}`))
          sdk.graph.claims.add({id:`${cp.id}:description:${entity.key}`,namespace:data.namespace,subject:id,predicate:'DESCRIPTION',
            value:entity.description,status:'proposed',confidence:0.8,method:'llm',model:data.model,extractionRun:cp.id,
            evidence:[{revisionId:data.revisionId,sourceId:data.sourceId,method:'llm',model:data.model,stance:'mentions'}]});
        // Cross-source identity: merge on strong keys or corroborated registry matches, queue the rest.
        const links = entity.urls ?? [];
        const resolved = resolver.resolveMention({entityId:id,type:entity.type,names:[entity.name,...(entity.aliases ?? []),...(entity.searchKeys ?? [])],
          match:entity.match ?? null,urls:links.filter(url=>/^https?:/i.test(url)),emails:links.filter(url=>url.includes('@'))});
        canonical.push(resolved.canonicalId);
        sdk.database.query('INSERT OR IGNORE INTO source_entities(source_id,entity_id) VALUES(?,?)').run(data.sourceId,resolved.canonicalId);
        for (const item of supporting ?? []) sdk.database.query(`INSERT OR IGNORE INTO chunk_entities(chunk_id,entity_id)
          SELECT id,? FROM chunks WHERE source_id=? AND chunk_index=?`).run(resolved.canonicalId,data.sourceId,item.chunkIndex);
        for (const source of sourceEntities) sdk.graph.claims.add({
          id:`${cp.id}:mention:${source.id}:${entity.key}`,namespace:data.namespace,subject:source.id,
          predicate:'MENTIONS_ENTITY',object:id,status:'proposed',method:'llm',model:data.model,
          extractionRun:cp.id,evidence:supporting ? groundEvidence(data,supporting)
            : [{revisionId:data.revisionId,sourceId:data.sourceId,method:'llm',model:data.model,stance:'mentions'}],
        });
      }
      if (data.first !== false && data.extraction.summary) for (const source of sourceEntities) sdk.graph.claims.add({
        id:`${cp.id}:summary:${source.id}`,namespace:data.namespace,subject:source.id,predicate:'SUMMARY',value:data.extraction.summary,
        status:'proposed',confidence:0.8,method:'llm',model:data.model,extractionRun:cp.id,
        evidence:[{revisionId:data.revisionId,sourceId:data.sourceId,method:'llm',model:data.model,stance:'mentions'}]});
      recordDigest(sdk, data, canonical);
      for (const [index,claim] of data.extraction.claims.entries()) {
        sdk.graph.claims.add({...consistentDatatype(claim),id:`${cp.id}:claim:${index}`,namespace:data.namespace,subject:ids.get(claim.subject)!,
          object:claim.object===undefined ? undefined : ids.get(claim.object)!,status:'proposed',method:'llm',model:data.model,
          extractionRun:cp.id,evidence:groundEvidence(data,claim.evidence)});
      }
      for (const event of data.extraction.events) {
        sdk.graph.events.create({stableId:`${cp.id}:event:${event.key}`,name:event.name,kind:event.kind,namespace:data.namespace,
          context:event.context,occurredFrom:event.occurredFrom,occurredTo:event.occurredTo,status:'proposed',
          method:'llm',model:data.model,extractionRun:cp.id,
          participants:event.participants.map(p=>({...p,entity:ids.get(p.entity)!})),evidence:groundEvidence(data,event.evidence)});
      }
      if (data.nextCursor) sdk.state.set(extractionCursorKey(data.revisionId), JSON.stringify(data.nextCursor));
      else {
        sdk.state.set(`extracted:${data.revisionId}`,'complete');
        sdk.state.delete(extractionCursorKey(data.revisionId));
      }
      sdk.checkpoint.resolve(cp.id);committed++;
    }
    return committed;
  }).immediate();
}
