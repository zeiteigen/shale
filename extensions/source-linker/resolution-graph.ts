import { createHash } from 'node:crypto';
import { graphIdentity, type ShaleSDK, type EvidenceInput, type IngestEdgeInput } from '@shale/sdk';
import type { DiscoveredLink } from './types';
import { sourceEntityName } from '../../lib/source-identity';

/** Coreference is a proposal scoped to the compared sources, never a name-based merge. */
export function commitResolutions(sdk: ShaleSDK, link: DiscoveredLink,
  sourceEntities: Record<string,number>, namespace: string): number {
  const pair = [link.sourceIdA,link.sourceIdB].sort();
  const edges: IngestEdgeInput[] = [];
  for (const resolution of link.entityResolutions ?? []) {
    const canonical = sdk.graph.entities.create({namespace,name:resolution.canonicalName,type:resolution.entityType || 'Entity',
      stableId:graphIdentity(namespace,resolution.entityType || 'Entity',JSON.stringify([pair,resolution.canonicalName]))});
    const add = (subject: number, predicate: string, evidence: EvidenceInput[], mentions?: string[]) => {
      const id = `resolution:${createHash('sha256').update(JSON.stringify([namespace,subject,canonical.id,predicate,
        link.extractionRun,evidence])).digest('hex')}`;
      edges.push({source:subject,target:canonical.id,relation:predicate,weight:resolution.confidence,
        metadata:{reason:resolution.reason,confidence:resolution.confidence,canonicalName:resolution.canonicalName,
          ...(mentions ? {mentions} : {})},
        claim:{id,status:'proposed',method:'llm',model:link.model,extractionRun:link.extractionRun,
          confidence:resolution.confidence,evidence,context:`source-pair:${JSON.stringify(pair)}`}});
    };
    for (const [sourceId,mentions,evidence] of [
      [link.sourceIdA,resolution.mentionsA,link.evidenceA ?? []],
      [link.sourceIdB,resolution.mentionsB,link.evidenceB ?? []],
    ] as Array<[string,string[],EvidenceInput[]]>) {
      if (mentions.length) add(sourceEntities[sourceEntityName(sourceId)],'MENTIONS_ENTITY',evidence,mentions);
      for (const mention of mentions) {
        if (mention.localeCompare(resolution.canonicalName,undefined,{sensitivity:'accent'}) === 0) continue;
        const alias = sdk.graph.entities.create({namespace,name:mention,type:'EntityAlias',
          stableId:graphIdentity(namespace,'EntityAlias',JSON.stringify([sourceId,mention])),
          aliases:[{name:mention,scope:`source:${sourceId}`}]});
        add(alias.id,'COREFERS_TO',evidence);
      }
    }
  }
  return sdk.graph.ingest({namespace,entities:[],edges}).edgesInserted;
}
