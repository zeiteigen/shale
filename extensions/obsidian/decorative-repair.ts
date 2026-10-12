import type { ShaleSDK } from "@shale/sdk";
import { isDecorativeImageUrl } from "../../lib/decorative-images";
import { markdownImages } from "../../lib/markdown-images";
import { recordVersion, checkVersion } from "../../sdk/knowledge/version";
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fingerprintText } from '../../lib/memory/fingerprint';

export interface DecorativeRepair {
  sourceId: string;
  uri: string;
  title: string;
  sourceVersion: number;
  memoryVersion: number;
  fingerprint: string;
  generatedMemoryDirty: boolean;
  claims: Array<{claimId: string; expectedVersion: number}>;
}

/** Inspect only sources and evidence visible through the caller's access profile. */
export function findDecorativeRepairs(sdk: ShaleSDK, sourceId?: string): DecorativeRepair[] {
  const sources = sdk.database.query<{id:string;uri:string;title:string},[string|null]>(
    "SELECT id,uri,title FROM sources WHERE origin='obsidian' AND type='markdown_note' AND (?1 IS NULL OR id=?1)")
    .all(sourceId ?? null);
  return sources.flatMap(source => {
    const memory = sdk.memory.get(source.id);
    const claims = sdk.database.query<{id:string;qualifiers:string},[string,string]>(
      `SELECT DISTINCT c.id,c.qualifiers FROM graph_claims c JOIN graph_evidence e ON e.claim_id=c.id
       JOIN graph_source_revisions r ON r.id=e.revision_id
       WHERE r.source_id=? AND c.context=? AND c.predicate='FEATURES_IMAGE' AND c.method='markdown'
       AND c.status IN ('accepted','proposed','disputed','stale')`).all(source.id, source.uri)
      .filter(c => isDecorativeImageUrl(JSON.parse(c.qualifiers).target ?? ""))
      .map(c => ({claimId:c.id,expectedVersion:recordVersion(sdk.database,'claim',c.id)}));
    const generated = [memory.summary.method==='agent' ? '' : memory.summary.text,
      ...memory.snippets.filter(s=>s.purpose==='source coverage').map(s=>s.text)];
    let generatedMemoryDirty = generated.some(text => markdownImages(text).some(i=>isDecorativeImageUrl(i.target)));
    if (generatedMemoryDirty) {
      try {
        const raw=readFileSync(fileURLToPath(source.uri),'utf8');
        // Bounded summaries/excerpts can lose code fences. Verify against the unchanged original.
        const body=raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
        if (fingerprintText(raw)===memory.freshness.fingerprint &&
          !markdownImages(body).some(i=>isDecorativeImageUrl(i.target))) generatedMemoryDirty=false;
      } catch { /* An unavailable original remains a reported repair candidate. */ }
    }
    return claims.length || generatedMemoryDirty ? [{sourceId:source.id,uri:source.uri,title:source.title,
      sourceVersion:recordVersion(sdk.database,'source',source.id),memoryVersion:memory.version,
      fingerprint:memory.freshness.fingerprint,generatedMemoryDirty,claims}] : [];
  });
}

/** Revalidate the dry-run report inside the write transaction. */
export function checkDecorativeRepair(sdk: ShaleSDK, repair: DecorativeRepair) {
  checkVersion(sdk.database,'source',repair.sourceId,repair.sourceVersion);
  const memory = sdk.memory.get(repair.sourceId);
  if (memory.version!==repair.memoryVersion || memory.freshness.fingerprint!==repair.fingerprint)
    throw new Error('Source memory changed after inspection; rerun the repair preview');
  for (const claim of repair.claims) checkVersion(sdk.database,'claim',claim.claimId,claim.expectedVersion);
}
