import type { Database } from 'bun:sqlite';
import { canonicalRoots, optionalExport, ratio } from './common';

/**
 * Extraction replay: the entities the model linked for each digested source (graph_source_digests.entity_ids,
 * canonicalised through merges) are the reference; a deterministic extractor is scored on recall, and on
 * precision against that same reference (a lower bound, since the model also misses entities).
 *
 * Extractor contract (phase P3's gazetteer plugs in here): a module exporting
 *   extractEntities(db: Database, sourceId: string): number[] | Promise<number[]>   // entity ids, any merge member
 */
export type EntityExtractor = (db: Database, sourceId: string) => number[] | Promise<number[]>;

export function digestEntities(db: Database, limit?: number): Map<string, Set<number>> {
  const root = canonicalRoots(db);
  const rows = db.query<{ source_id: string; entity_ids: string }, []>(
    `SELECT source_id,entity_ids FROM graph_source_digests ORDER BY digested_at DESC${limit ? ` LIMIT ${Math.floor(limit)}` : ''}`).all();
  return new Map(rows.map(row => [row.source_id, new Set((JSON.parse(row.entity_ids) as number[]).map(root))]));
}

export interface ExtractionScore { sources: number; reference: number; predicted: number; hits: number; microRecall: number | null; microPrecision: number | null; macroRecall: number | null; fullRecallSources: number }

/** Pure scoring over canonical id sets; `root` canonicalises the extractor's ids the same way as the reference's. */
export function scoreExtraction(reference: Map<string, Set<number>>, predicted: Map<string, number[]>, root: (id: number) => number = id => id): ExtractionScore {
  let ref = 0, pred = 0, hits = 0, macro = 0, macroCount = 0, full = 0;
  for (const [source, expected] of reference) {
    const got = new Set((predicted.get(source) ?? []).map(root));
    let hit = 0; for (const id of got) if (expected.has(id)) hit++;
    ref += expected.size; pred += got.size; hits += hit;
    if (expected.size) { macro += hit / expected.size; macroCount++; if (hit === expected.size) full++; }
  }
  return { sources: reference.size, reference: ref, predicted: pred, hits, microRecall: ratio(hits, ref), microPrecision: ratio(hits, pred),
    macroRecall: ratio(macro, macroCount), fullRecallSources: full };
}

export async function evaluateExtractor(db: Database, extractor: EntityExtractor, limit?: number) {
  const reference = digestEntities(db, limit), predicted = new Map<string, number[]>();
  for (const source of reference.keys()) predicted.set(source, await extractor(db, source));
  return scoreExtraction(reference, predicted, canonicalRoots(db));
}

export async function loadExtractor(modulePath?: string) {
  const paths = modulePath ? [modulePath] : ['lib/graph/gazetteer.ts', 'extensions/knowledge-extractor/gazetteer.ts'];
  return optionalExport<EntityExtractor>(paths, ['extractEntities']);
}
