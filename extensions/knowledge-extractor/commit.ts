import { createHash } from 'node:crypto';
import type { ShaleSDK } from '@shale/sdk';
import type { ExtractionCheckpoint } from './types';
import { groundEvidence } from './evidence';
import { extractionCursorKey } from './source-window';
import { validateTemporalEvidence } from './temporal-evidence';
import { IdentityResolver } from '../../sdk/graph/identity';
import { ensureStorySchema } from '../../lib/graph/story-schema';
import type { ExtractedClaim, ExtractedEntity } from './types';
import { consistentDatatype } from './claim-datatype';
import { canonicalOf } from '../../sdk/graph/registry';
import { canonicalPredicate } from '../../lib/graph/predicates';
import { recordShadowLLM, shadowMode, type ShadowMode } from '../../lib/graph/shadow';
import { templateLLMVerdict } from './templates';
import type { GraphValue } from '@shale/sdk';
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
  const read = data.involvement ?? data.extraction.involvement;
  const involvement = data.digest?.userAbsent && ['participant', 'author'].includes(read ?? '') ? 'observer' : read;
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

/**
 * Model predicates mapped onto the closed schema (lib/graph/predicates.ts). Lossless: the model's wording stays in
 * qualifiers.rawPredicate (and qualifiers.label for RELATED_TO), so the mapping can be revised and replayed. Shadow
 * mode keeps the model's predicate and records the mapping beside it in qualifiers.canonicalPredicate.
 */
function typedClaim(claim: ExtractedClaim, mode: ShadowMode, types: Map<string, string>) {
  if (mode === 'off' || claim.method !== undefined) return claim;
  const mapped = canonicalPredicate(claim.predicate, types.get(claim.subject), claim.object === undefined ? null : types.get(claim.object));
  if (mapped.predicate === claim.predicate) return claim;
  const qualifiers: Record<string, GraphValue> = { ...(claim.qualifiers ?? {}) };
  if (mode === 'shadow') return { ...claim, qualifiers: { ...qualifiers, canonicalPredicate: mapped.predicate } };
  return { ...claim, predicate: mapped.predicate, qualifiers: { ...qualifiers, rawPredicate: claim.predicate,
    ...(mapped.label && qualifiers.label === undefined ? { label: mapped.label } : {}) } };
}

/** Resolve checkpoints and progress in the same transaction as graph writes. */
export function commitExtractions(sdk: ShaleSDK) {
  ensureStorySchema(sdk.database);
  const predicateMode = shadowMode(sdk.settings.get<string>('predicateSchema') ?? 'active');
  return sdk.database.transaction(()=> {
    let committed=0;
    for (const cp of sdk.checkpoint.getQueue<ExtractionCheckpoint>()) {
      if (!cp.id.startsWith('knowledge-extraction:') || cp.data.type!=='knowledge-extraction') continue;
      const data=cp.data;
      validateTemporalEvidence(data);
      const ids=new Map<string,number>();
      const types=new Map<string,string>();
      for (const entity of data.extraction.entities) {
        if (entity.entityId !== undefined) {
          // A deterministic link names an existing registry identity; it is committed as that identity.
          const id = canonicalOf(sdk.database, entity.entityId);
          const row = sdk.database.query<{ type: string }, [number]>(`SELECT type FROM entities e WHERE id=?
            AND NOT EXISTS(SELECT 1 FROM graph_entity_retirements r WHERE r.entity_id=e.id)`).get(id);
          if (row) { ids.set(entity.key, id); types.set(entity.key, row.type); }
          continue;
        }
        const stableId=`extracted:${createHash('sha256').update(JSON.stringify([data.namespace,data.sourceId,entity.type,entity.name])).digest('hex')}`;
        const node=sdk.graph.entities.create({stableId,name:entity.name,type:entity.type,namespace:data.namespace,
          aliases:entity.aliases?.map(name=>({name,scope:`source:${data.sourceId}`}))});
        ids.set(entity.key,node.id);
        types.set(entity.key,entity.type);
      }
      // Connector identity aliases bridge the document and its extracted entities.
      const sourceEntities = sdk.graph.entities.resolve(data.sourceId,'source-id');
      const text = data.chunks.map(chunk=>chunk.text_content).join('\n');
      const resolver = new IdentityResolver(sdk.database, sdk.graph);
      const canonical: number[] = [];
      const modelEntities: number[] = [];
      for (const entity of data.extraction.entities) {
        const id = ids.get(entity.key);
        if (id === undefined) continue;
        const method = entity.method ?? 'llm', model = entity.method ? undefined : data.model;
        const supporting = data.extraction.claims.find(claim=>claim.subject===entity.key || claim.object===entity.key)?.evidence
          ?? data.extraction.events.find(event=>event.participants.some(p=>p.entity===entity.key))?.evidence
          ?? (entity.mentions?.length ? entity.mentions : undefined);
        if (entity.entityId === undefined && !supporting && !grounded(entity, text)) continue;
        let resolvedId = id;
        if (entity.entityId === undefined) {
          for (const key of entity.searchKeys ?? []) sdk.graph.entities.addAlias(id,key,'search');
          if (entity.description && !sdk.database.query('SELECT 1 FROM graph_claims WHERE id=?').get(`${cp.id}:description:${entity.key}`))
            sdk.graph.claims.add({id:`${cp.id}:description:${entity.key}`,namespace:data.namespace,subject:id,predicate:'DESCRIPTION',
              value:entity.description,status:'proposed',confidence:0.8,method,model,extractionRun:cp.id,
              evidence:[{revisionId:data.revisionId,sourceId:data.sourceId,method,model,stance:'mentions'}]});
          // Cross-source identity: merge on strong keys or corroborated registry matches, queue the rest.
          const links = entity.urls ?? [];
          resolvedId = resolver.resolveMention({entityId:id,type:entity.type,names:[entity.name,...(entity.aliases ?? []),...(entity.searchKeys ?? [])],
            match:entity.match ?? null,urls:links.filter(url=>/^https?:/i.test(url)),emails:links.filter(url=>url.includes('@'))}).canonicalId;
        }
        canonical.push(resolvedId);
        if (!entity.method) modelEntities.push(resolvedId);
        sdk.database.query('INSERT OR IGNORE INTO source_entities(source_id,entity_id) VALUES(?,?)').run(data.sourceId,resolvedId);
        for (const item of supporting ?? []) sdk.database.query(`INSERT OR IGNORE INTO chunk_entities(chunk_id,entity_id)
          SELECT id,? FROM chunks WHERE source_id=? AND chunk_index=?`).run(resolvedId,data.sourceId,item.chunkIndex);
        for (const source of sourceEntities) sdk.graph.claims.add({
          id:`${cp.id}:mention:${source.id}:${entity.key}`,namespace:data.namespace,subject:source.id,
          predicate:'MENTIONS_ENTITY',object:id,status:'proposed',method,model,
          extractionRun:cp.id,evidence:supporting ? groundEvidence(data,supporting,method)
            : [{revisionId:data.revisionId,sourceId:data.sourceId,method,model,stance:'mentions'}],
        });
      }
      const summaryMethod = data.templateIds ? 'template' : data.deterministicOnly ? 'extractive' : 'llm', summaryModel = data.deterministicOnly ? undefined : data.model;
      if (data.first !== false && data.extraction.summary) for (const source of sourceEntities) sdk.graph.claims.add({
        id:`${cp.id}:summary:${source.id}`,namespace:data.namespace,subject:source.id,predicate:'SUMMARY',value:data.extraction.summary,
        status:'proposed',confidence:data.deterministicOnly ? 0.5 : 0.8,method:summaryMethod,model:summaryModel,extractionRun:cp.id,
        evidence:[{revisionId:data.revisionId,sourceId:data.sourceId,method:summaryMethod,model:summaryModel,stance:'mentions'}]});
      recordDigest(sdk, data, canonical);
      for (const [index,raw] of data.extraction.claims.entries()) {
        const subject = ids.get(raw.subject), object = raw.object === undefined ? undefined : ids.get(raw.object);
        if (subject === undefined || (raw.object !== undefined && object === undefined)) continue;
        const { method: claimMethod, ...claim } = typedClaim(raw, predicateMode, types);
        const method = claimMethod ?? 'llm';
        sdk.graph.claims.add({...consistentDatatype(claim),id:`${cp.id}:claim:${index}`,namespace:data.namespace,subject,
          object,status:'proposed',method,model:claimMethod ? undefined : data.model,
          extractionRun:cp.id,evidence:groundEvidence(data,claim.evidence,method)});
      }
      for (const event of data.extraction.events) {
        sdk.graph.events.create({stableId:`${cp.id}:event:${event.key}`,name:event.name,kind:event.kind,namespace:data.namespace,
          context:event.context,occurredFrom:event.occurredFrom,occurredTo:event.occurredTo,status:'proposed',
          method:'llm',model:data.model,extractionRun:cp.id,
          participants:event.participants.filter(p=>ids.has(p.entity)).map(p=>({...p,entity:ids.get(p.entity)!})),evidence:groundEvidence(data,event.evidence)});
      }
      // The model's reading beside the deterministic verdict recorded before the call, for agreement measurement.
      if (data.shadowSubject && !data.deterministicOnly) recordShadowLLM(sdk.database, 'extraction', data.shadowSubject, {
        entities: [...new Set(modelEntities)], involvement: data.extraction.involvement ?? null,
        temporal: data.extraction.claims.filter(claim => !claim.method && (claim.validFrom !== undefined || claim.validTo !== undefined
          || ['HAS_DEADLINE', 'SCHEDULED_FOR', 'STARTS_ON', 'ENDS_ON'].includes(canonicalPredicate(claim.predicate, types.get(claim.subject),
            claim.object === undefined ? null : types.get(claim.object)).predicate)))
          .map(claim => ({ predicate: claim.predicate, value: claim.value ?? null, validFrom: claim.validFrom ?? null, validTo: claim.validTo ?? null,
            quote: claim.evidence[0]?.quote ?? null })),
      });
      if (data.templateShadow && !data.deterministicOnly) recordShadowLLM(sdk.database, 'template', data.templateShadow, templateLLMVerdict(data.extraction));
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
