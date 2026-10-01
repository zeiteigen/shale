import { createHash } from 'node:crypto';
import type { ShaleSDK } from '@shale/sdk';
import type { ExtractionCheckpoint } from './types';
import { groundEvidence } from './evidence';

/** Resolve checkpoints and progress in the same transaction as graph writes. */
export function commitExtractions(sdk: ShaleSDK) {
  return sdk.database.transaction(()=> {
    let committed=0;
    for (const cp of sdk.checkpoint.getQueue<ExtractionCheckpoint>()) {
      if (!cp.id.startsWith('knowledge-extraction:') || cp.data.type!=='knowledge-extraction') continue;
      const data=cp.data;
      const ids=new Map<string,number>();
      for (const entity of data.extraction.entities) {
        const stableId=`extracted:${createHash('sha256').update(JSON.stringify([data.namespace,data.sourceId,entity.type,entity.name])).digest('hex')}`;
        const node=sdk.graph.entities.create({stableId,name:entity.name,type:entity.type,namespace:data.namespace,
          aliases:entity.aliases?.map(name=>({name,scope:`source:${data.sourceId}`}))});
        ids.set(entity.key,node.id);
      }
      // Connector identity aliases bridge the document and its extracted entities.
      const sourceEntities = sdk.graph.entities.resolve(data.sourceId,'source-id');
      for (const entity of data.extraction.entities) {
        const supporting = data.extraction.claims.find(claim=>claim.subject===entity.key || claim.object===entity.key)?.evidence
          ?? data.extraction.events.find(event=>event.participants.some(p=>p.entity===entity.key))?.evidence;
        if (!supporting) continue;
        for (const source of sourceEntities) sdk.graph.claims.add({
          id:`${cp.id}:mention:${source.id}:${entity.key}`,namespace:data.namespace,subject:source.id,
          predicate:'MENTIONS_ENTITY',object:ids.get(entity.key)!,status:'proposed',method:'llm',model:data.model,
          extractionRun:cp.id,evidence:groundEvidence(data,supporting),
        });
      }
      for (const [index,claim] of data.extraction.claims.entries()) {
        sdk.graph.claims.add({...claim,id:`${cp.id}:claim:${index}`,namespace:data.namespace,subject:ids.get(claim.subject)!,
          object:claim.object===undefined ? undefined : ids.get(claim.object)!,status:'proposed',method:'llm',model:data.model,
          extractionRun:cp.id,evidence:groundEvidence(data,claim.evidence)});
      }
      for (const event of data.extraction.events) {
        sdk.graph.events.create({stableId:`${cp.id}:event:${event.key}`,name:event.name,kind:event.kind,namespace:data.namespace,
          context:event.context,occurredFrom:event.occurredFrom,occurredTo:event.occurredTo,status:'proposed',
          method:'llm',model:data.model,extractionRun:cp.id,
          participants:event.participants.map(p=>({...p,entity:ids.get(p.entity)!})),evidence:groundEvidence(data,event.evidence)});
      }
      sdk.state.set(`extracted:${data.revisionId}`,'complete');
      sdk.checkpoint.resolve(cp.id);committed++;
    }
    return committed;
  })();
}
