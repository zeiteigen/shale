import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ShaleSDK } from "@shale/sdk";
import { parseFile } from "./parse-file";
import { fingerprintText } from "../../lib/memory/fingerprint";
import { withSourceRefresh } from "../../lib/memory/refresh-scope";
import { memoryChunks } from "../../lib/memory/prepare";
import { checkDecorativeRepair, type DecorativeRepair } from "./decorative-repair";

/** Prepare from the original without models, then atomically rebuild memory and retire icon links. */
export async function applyDecorativeRepair(sdk: ShaleSDK, repair: DecorativeRepair) {
  const path = fileURLToPath(repair.uri);
  const file = await parseFile(path,sdk,{expandAtomicNotes:false});
  if (file.sourceFingerprint!==repair.fingerprint)
    throw new Error('The original note changed since ingestion; ingest it before repairing its generated memory');
  const input = {sourceId:repair.sourceId,sourceVersion:repair.sourceVersion,memoryVersion:repair.memoryVersion,claims:repair.claims};
  return sdk.knowledge.record('repair_source_memory',input,{
    actor:'maintenance:decorative-images',reason:'Remove decorative image references and rebuild generated note memory',
    requestId:`decorative-images:${repair.sourceId}:${repair.memoryVersion}:${repair.sourceVersion}`,
  }, () => {
    checkDecorativeRepair(sdk,repair);
    if (fingerprintText(readFileSync(path,'utf8'))!==file.sourceFingerprint)
      throw new Error('The original note changed during repair; rerun the preview');
    const source = sdk.database.query<{id:string;type:string;uri:string;origin:string;title:string;created_at:number;updated_at:number},[string]>(
      'SELECT id,type,uri,origin,title,created_at,updated_at FROM sources WHERE id=?').get(repair.sourceId)!;
    const namespace = sdk.database.query<{namespace:string},[string]>(
      "SELECT e.namespace FROM source_entities se JOIN entities e ON e.id=se.entity_id WHERE se.source_id=? AND e.type='Note' LIMIT 1")
      .get(repair.sourceId)?.namespace ?? 'obsidian';
    withSourceRefresh({sourceId:repair.sourceId,uri:repair.uri,mode:'rebuild-generated'}, () => {
      const result=sdk.ingest.sourceAndChunks({source:{...source,hash:file.sourceFingerprint},namespace,
        memory:file.memory,chunks:memoryChunks(file.memory!)});
      if (result.skipped) throw new Error('Source is excluded from ingestion');
    });
    for (const {claimId} of repair.claims)
      sdk.graph.lifecycle.review(claimId,'retracted','maintenance:decorative-images','Decorative Markdown image');
    return {sourceId:repair.sourceId,retractedClaims:repair.claims.length,memoryVersion:sdk.memory.get(repair.sourceId).version};
  });
}
