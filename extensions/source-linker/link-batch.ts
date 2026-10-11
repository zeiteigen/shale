import type { ShaleSDK, Source } from "@shale/sdk";
import type { SourceCandidatePair } from "./types";

export const WATERMARK_KEY = "last_source_update";
export const BATCH_ID = "source_link_batch";

interface LinkBatchRow {
  type: "link_batch";
  sourcesAnalyzed: number;
  maxUpdatedAt: number;
  pairs: SourceCandidatePair[];
}

interface QueuePair {
  checkpoint_id: string;
  source_a_id: string; source_a_hash: string; source_a_uri: string; source_a_type: string;
  source_a_origin: string; source_a_title: string; source_a_created_at: number; source_a_updated_at: number;
  source_b_id: string; source_b_hash: string; source_b_uri: string; source_b_type: string;
  source_b_origin: string; source_b_title: string; source_b_created_at: number; source_b_updated_at: number;
  text_score: number;
}

/** Persist only source/revision references and scores; source text stays out of the work queue. */
export function ensureLinkQueue(sdk: ShaleSDK): void {
  sdk.database.run(`
    CREATE TABLE IF NOT EXISTS source_link_batch (
      id TEXT PRIMARY KEY CHECK(id='current'), sources_analyzed INTEGER NOT NULL,
      max_updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS source_link_work (
      checkpoint_id TEXT PRIMARY KEY,
      source_a_id TEXT NOT NULL, source_a_hash TEXT NOT NULL, source_a_uri TEXT NOT NULL,
      source_a_type TEXT NOT NULL, source_a_origin TEXT NOT NULL, source_a_title TEXT NOT NULL,
      source_a_created_at INTEGER NOT NULL, source_a_updated_at INTEGER NOT NULL,
      source_b_id TEXT NOT NULL, source_b_hash TEXT NOT NULL, source_b_uri TEXT NOT NULL,
      source_b_type TEXT NOT NULL, source_b_origin TEXT NOT NULL, source_b_title TEXT NOT NULL,
      source_b_created_at INTEGER NOT NULL, source_b_updated_at INTEGER NOT NULL,
      text_score REAL NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS source_link_work_order ON source_link_work(text_score DESC,checkpoint_id);
  `);
}

export const pairCheckpointId = (pair: SourceCandidatePair): string =>
  `link_analysis:${pair.sourceA.id}:${pair.sourceB.id}`;

function asSource(row: QueuePair, prefix: "a" | "b"): Source {
  const key = `source_${prefix}_`;
  return {
    id: row[`${key}id` as keyof QueuePair] as string,
    hash: row[`${key}hash` as keyof QueuePair] as string,
    uri: row[`${key}uri` as keyof QueuePair] as string,
    type: row[`${key}type` as keyof QueuePair] as string,
    origin: row[`${key}origin` as keyof QueuePair] as string,
    title: row[`${key}title` as keyof QueuePair] as string,
    created_at: row[`${key}created_at` as keyof QueuePair] as number,
    updated_at: row[`${key}updated_at` as keyof QueuePair] as number,
  };
}

function mapPair(row: QueuePair): SourceCandidatePair {
  return { sourceA: asSource(row, "a"), sourceB: asSource(row, "b"), textScore: row.text_score, matchedChunkIds: [] };
}

export function enqueueLinkBatch(sdk: ShaleSDK, batch: Omit<LinkBatchRow, "pairs">, pairs: SourceCandidatePair[]): void {
  ensureLinkQueue(sdk);
  const insert = sdk.database.query(`INSERT OR IGNORE INTO source_link_work(
    checkpoint_id,source_a_id,source_a_hash,source_a_uri,source_a_type,source_a_origin,source_a_title,source_a_created_at,source_a_updated_at,
    source_b_id,source_b_hash,source_b_uri,source_b_type,source_b_origin,source_b_title,source_b_created_at,source_b_updated_at,text_score
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const txn = sdk.database.transaction(() => {
    sdk.database.query("INSERT OR REPLACE INTO source_link_batch(id,sources_analyzed,max_updated_at) VALUES('current',?,?)")
      .run(batch.sourcesAnalyzed, batch.maxUpdatedAt);
    for (const pair of pairs) insert.run(pairCheckpointId(pair), pair.sourceA.id, pair.sourceA.hash,
      pair.sourceA.uri, pair.sourceA.type, pair.sourceA.origin, pair.sourceA.title, pair.sourceA.created_at, pair.sourceA.updated_at,
      pair.sourceB.id, pair.sourceB.hash, pair.sourceB.uri, pair.sourceB.type, pair.sourceB.origin, pair.sourceB.title,
      pair.sourceB.created_at, pair.sourceB.updated_at, pair.textScore);
  });
  txn();
}

/** A bounded page of queued pairs. */
export function nextLinkPairs(sdk: ShaleSDK, limit: number): SourceCandidatePair[] {
  ensureLinkQueue(sdk);
  return sdk.database.query<QueuePair, [number]>(
    "SELECT * FROM source_link_work ORDER BY text_score DESC,checkpoint_id LIMIT ?",
  ).all(limit).map(mapPair);
}

/** Current batch metadata plus one optional bounded page (defaults preserve legacy callers). */
export function readLinkBatch(sdk: ShaleSDK, limit = Number.MAX_SAFE_INTEGER): LinkBatchRow | undefined {
  ensureLinkQueue(sdk);
  const meta = sdk.database.query<{ sources_analyzed: number; max_updated_at: number }, []>(
    "SELECT sources_analyzed,max_updated_at FROM source_link_batch WHERE id='current'",
  ).get();
  if (meta) return { type: "link_batch", sourcesAnalyzed: meta.sources_analyzed,
    maxUpdatedAt: meta.max_updated_at, pairs: nextLinkPairs(sdk, limit) };
  // Read old checkpoint batches during upgrade. New batches never put pair data in checkpoints.
  return sdk.checkpoint.get<LinkBatchRow>(BATCH_ID)?.data;
}

/** Invoke inside the graph commit transaction so progress never outruns persistence. */
export function completeLinkPairs(sdk: ShaleSDK, completed: Set<string>): void {
  ensureLinkQueue(sdk);
  for (const owner of completed) sdk.database.query("DELETE FROM source_memory_pins WHERE owner=?").run(owner);
  const batch = sdk.database.query<{ sources_analyzed: number; max_updated_at: number }, []>(
    "SELECT sources_analyzed,max_updated_at FROM source_link_batch WHERE id='current'",
  ).get();
  if (!batch) {
    // Legacy pair checkpoints cannot prove a complete batch, so preserve the old behavior.
    const old = sdk.checkpoint.get<LinkBatchRow>(BATCH_ID)?.data;
    if (old) {
      const pairs = old.pairs.filter(pair => !completed.has(pairCheckpointId(pair)));
      if (pairs.length) sdk.saveCheckpoint({ ...old, pairs }, { id: BATCH_ID, key: BATCH_ID });
      else {
        const watermark = Number(sdk.state.getWatermark(WATERMARK_KEY) ?? "0");
        if (old.maxUpdatedAt > watermark) sdk.state.setWatermark(String(old.maxUpdatedAt), WATERMARK_KEY);
        sdk.deleteCheckpoint(BATCH_ID);
      }
    }
    return;
  }
  for (const id of completed) sdk.database.query("DELETE FROM source_link_work WHERE checkpoint_id=?").run(id);
  const remaining = sdk.database.query<{ count: number }, []>("SELECT count(*) AS count FROM source_link_work").get()!.count;
  if (remaining) return;
  const watermark = Number(sdk.state.getWatermark(WATERMARK_KEY) ?? "0");
  if (batch.max_updated_at > watermark) sdk.state.setWatermark(String(batch.max_updated_at), WATERMARK_KEY);
  sdk.database.query("DELETE FROM source_link_batch WHERE id='current'").run();
}
