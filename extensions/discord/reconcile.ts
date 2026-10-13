import type { ShaleSDK } from "@shale/sdk";
import { recordVersion } from "@shale/sdk/knowledge/version";
import { retireUnsupportedEntities } from "../../lib/graph/retirements";

export function preserveDiscordSource(sdk: ShaleSDK,sourceId: string): boolean {
  return !!sdk.database.query("SELECT 1 FROM graph_changes WHERE actor NOT LIKE 'extension:discord%' AND operations LIKE ?")
    .get(`%"sourceId":"${sourceId}"%`)
    || !!sdk.database.query("SELECT 1 FROM source_memory_changes WHERE source_id=? AND actor NOT LIKE 'extension:discord%'").get(sourceId);
}

/** Retract only this connector's assertions, preserving manual reviews and independent sources. */
export function reconcileDiscordGraph(sdk: ShaleSDK, sourceId: string, onlyEntities?:number[]) {
  const selected=onlyEntities ? JSON.stringify(onlyEntities) : null;
  const claims=sdk.database.query<{id:string;subject_id:number;object_id:number|null},[string,string|null,string|null,string|null]>(
    `SELECT DISTINCT c.id,c.subject_id,c.object_id FROM graph_claims c
      JOIN graph_evidence e ON e.claim_id=c.id JOIN graph_source_revisions r ON r.id=e.revision_id
      WHERE r.source_id=? AND c.method IN ('connector','llm','heuristic')
        AND (? IS NULL OR c.subject_id IN (SELECT value FROM json_each(?)) OR c.object_id IN (SELECT value FROM json_each(?)))
        AND c.status NOT IN ('retracted','rejected','superseded')
        AND NOT EXISTS(SELECT 1 FROM graph_reviews v WHERE v.claim_id=c.id AND v.actor NOT LIKE 'extension:discord%')
        AND NOT EXISTS(SELECT 1 FROM graph_evidence other JOIN graph_source_revisions rr ON rr.id=other.revision_id
          JOIN sources s ON s.id=rr.source_id WHERE other.claim_id=c.id AND rr.source_id!=r.source_id)`)
    .all(sourceId,selected,selected,selected);
  const entities=[...new Set(claims.flatMap(claim=>[claim.subject_id,...(claim.object_id === null ? [] : [claim.object_id])]))];
  sdk.knowledge.record("discord_reconcile",{sourceId,claimIds:claims.map(claim=>claim.id),entityIds:entities},
    {actor:"extension:discord",reason:"Discord relevance or contributor selection changed"},()=>{
      for (const claim of claims) sdk.graph.lifecycle.review(claim.id,"retracted","extension:discord","Discord relevance changed");
      const bridges=JSON.stringify(onlyEntities ?? entities);
      sdk.database.query(`DELETE FROM source_entities WHERE source_id=? AND entity_id IN (SELECT value FROM json_each(?))`)
        .run(sourceId,bridges);
      sdk.database.query(`DELETE FROM chunk_entities WHERE chunk_id IN (SELECT id FROM chunks WHERE source_id=?)
        AND entity_id IN (SELECT value FROM json_each(?))`).run(sourceId,bridges);
      retireUnsupportedEntities(sdk.database,onlyEntities ?? entities,"Discord context excluded or contributor no longer selected");
      return {retracted:claims.length};
    });
}

export async function excludeDiscordSource(sdk: ShaleSDK, sourceId: string) {
  const source=sdk.context.getSource(sourceId);
  if (!source) {
    // Resume a crash between audited removal and projection reconciliation.
    if (sdk.database.query(`SELECT 1 FROM graph_source_archives WHERE source_id=? AND json_extract(snapshot,'$.source.origin')='discord'`).get(sourceId))
      reconcileDiscordGraph(sdk,sourceId);
    return;
  }
  if (source.origin !== "discord") return;
  // Explicit memory edits remain owned by the user rather than the automatic classifier.
  if (preserveDiscordSource(sdk,sourceId)) return;
  await sdk.knowledge.apply({actor:"extension:discord",reason:"Excluded by Discord relevance policy",
    operations:[{type:"remove_source",args:{sourceId,expectedVersion:recordVersion(sdk.database,"source",sourceId),blockReingestion:false}}]});
  reconcileDiscordGraph(sdk,sourceId);
}
