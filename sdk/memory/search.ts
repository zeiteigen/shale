import type { Database } from 'bun:sqlite';
import { extractKeywords } from '../search';
import { searchIndexReady, searchSources } from '../retrieval/engine';

export type MemoryRanker = 'bm25' | 'engine';

export interface MemorySearchOptions {
  query: string;
  limit?: number;
  offset?: number;
  origin?: string;
  type?: string;
  sourceId?: string;
  /**
   * 'bm25' ranks each source by its best chunk's BM25 (the original path). 'engine' uses the fielded search engine
   * (sdk/retrieval/engine.ts: query understanding, feature ranking, near-duplicate collapsing); it falls back to
   * 'bm25' while the search index has not been built. Callers pass the knowledge-graph `searchRanker` setting.
   */
  ranker?: MemoryRanker;
  /** Engine feature-weight overrides (the knowledge-graph `searchWeights` setting). */
  weights?: Record<string, unknown> | null;
  /** Engine only: per-feature score contributions on each hit. */
  explain?: boolean;
}

const ACTIVITY_TYPES = ['browser_activity','browser_history','browser_session_analysis','web_session','browser_bookmark','bookmark','history_batch','bookmarks_batch','history_item','bookmark_item'];

interface HitRow { source_id: string; chunk_index: number; preview: string; title: string; uri: string; origin: string; type: string }

/** One hit: source fields, memory version, the passage's citation id, and the latest capture's metadata. */
function memoryHit(db: Database, row: HitRow) {
  const memory = db.query<{ version:number; summary_version:number }, [string]>(
    'SELECT version,summary_version FROM source_memories WHERE source_id=?').get(row.source_id);
  const passage = db.query<{ versionId:number; kind:string }, [string,number]>(
    `SELECT p.id AS versionId,p.kind FROM graph_revision_passages p
     JOIN graph_source_revisions r ON r.id=p.revision_id
     JOIN sources s ON s.id=r.source_id AND s.hash=r.hash
     WHERE s.id=? AND p.chunk_index=?`).get(row.source_id,row.chunk_index);
  const isSummary = row.chunk_index === 0;
  const capture = db.query<{metadata:string},[string]>(
    'SELECT metadata FROM source_observations WHERE source_id=? ORDER BY captured_at DESC,id DESC LIMIT 1').get(row.source_id);
  return {
    sourceId: row.source_id, title: row.title, uri: row.uri, origin: row.origin, type: row.type,
    memoryVersion: memory?.version ?? null,
    summaryVersionId: isSummary ? memory?.summary_version ?? passage?.versionId ?? null : null,
    snippetVersionId: !isSummary ? passage?.versionId ?? null : null,
    kind: isSummary ? 'summary' : passage?.kind ?? 'snippet',
    observation:capture?JSON.parse(capture.metadata):null,
    preview: row.preview.slice(0,600),
  };
}

/** Registry entities the engine linked from the query (empty for bm25): better graph seeds than hit guesses. */
export interface LinkedEntity { id: number; name: string; surface: string }

export type MemoryHit = ReturnType<typeof memoryHit> & {
  /** Engine: near-duplicates, template or thread siblings this hit stands for. */
  similar?: string[];
  /** Engine: index fields, query entities, and query words this hit matched. */
  matched?: { fields: string[]; entities: number[]; terms: string[] };
  explain?: Record<string, number>;
};

/** Search retained memory and rank the best matching passage once per source. */
export function searchMemory(db: Database, options: MemorySearchOptions) {
  const limit = options.limit ?? 5;
  const offset = options.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be between 1 and 100');
  if (!Number.isInteger(offset) || offset < 0) throw new Error('offset must be a nonnegative integer');
  if (options.ranker === 'engine' && searchIndexReady(db)) return engineSearch(db, options, limit, offset);
  const keywords = extractKeywords(options.query, { db });
  if (!keywords.length) return { hits: [] as MemoryHit[], offset, limit, totalSources: 0, truncated: false, nextOffset: null, ranker: 'bm25' as MemoryRanker, entities: [] as LinkedEntity[] };
  const match = keywords.map(word => `"${word.replace(/"/g, '""')}"`).join(' OR ');
  const filters: string[] = [];
  const bindings: (string|number)[] = [match];
  if (options.origin) { filters.push('s.origin=?'); bindings.push(options.origin); }
  if (options.type) { filters.push('s.type=?'); bindings.push(options.type); }
  if (options.sourceId) { filters.push('(s.id=? OR s.uri=?)'); bindings.push(options.sourceId, options.sourceId); }
  if (!options.type && !options.sourceId) {
    filters.push(`s.type NOT IN (${ACTIVITY_TYPES.map(() => '?').join(',')})`);
    bindings.push(...ACTIVITY_TYPES);
    filters.push(`(s.type NOT IN ('web_page','public_web_page') OR coalesce((SELECT json_extract(o.metadata,'$.quality')
      FROM source_observations o WHERE o.source_id=s.id ORDER BY o.captured_at DESC,o.id DESC LIMIT 1),'unknown')<>'metadata')`);
  }
  const whereFilters = filters.length ? `AND ${filters.join(' AND ')}` : '';
  const base = `WITH matched AS MATERIALIZED (
      SELECT c.id,c.source_id,c.chunk_index,substr(c.text_content,1,601) AS preview,
             s.title,s.uri,s.origin,s.type,bm25(chunks_fts) AS score
        FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.rowid JOIN sources s ON s.id=c.source_id
       WHERE chunks_fts MATCH ? ${whereFilters}
    ), ranked AS MATERIALIZED (
      SELECT *,row_number() OVER(PARTITION BY source_id ORDER BY score,id) AS source_rank FROM matched
    )`;
  const totalSources = db.query<{ total: number }, (string|number)[]>(`${base} SELECT count(*) AS total FROM ranked WHERE source_rank=1`).get(...bindings)?.total ?? 0;
  const rows = db.query<HitRow & { id:number; score:number }, (string|number)[]>(
    `${base} SELECT id,source_id,chunk_index,preview,title,uri,origin,type,score FROM ranked
      WHERE source_rank=1 ORDER BY score,id LIMIT ? OFFSET ?`,
  ).all(...bindings, limit + 1, offset);
  const page = rows.slice(0, limit);
  const hits: MemoryHit[] = page.map(row => memoryHit(db, row));
  const hasMore = offset + page.length < totalSources;
  return { hits, offset, limit, totalSources, truncated: hasMore, nextOffset: hasMore ? offset + page.length : null, ranker: 'bm25' as MemoryRanker, entities: [] as LinkedEntity[] };
}

/** The engine path: same hit shape (the preview is the engine's best passage), plus similar/matched/explain. */
function engineSearch(db: Database, options: MemorySearchOptions, limit: number, offset: number) {
  const results = searchSources(db, options.query, { limit, offset, explain: options.explain, weights: options.weights,
    filters: { origin: options.origin, type: options.type, sourceId: options.sourceId } });
  const hits: MemoryHit[] = [];
  for (const result of results) {
    const row = db.query<HitRow, [number, string]>(`SELECT s.id AS source_id,?1 AS chunk_index,coalesce((SELECT substr(text_content,1,601) FROM chunks
      WHERE source_id=s.id AND chunk_index=?1 ORDER BY id LIMIT 1),'') AS preview,s.title,s.uri,s.origin,s.type FROM sources s WHERE s.id=?2`).get(result.chunkIndex, result.sourceId);
    if (!row) continue;
    hits.push({ ...memoryHit(db, row), similar: result.similar, matched: result.matched, ...(result.explain ? { explain: result.explain } : {}) });
  }
  const hasMore = offset + results.length < results.total;
  return { hits, offset, limit, totalSources: results.total, truncated: hasMore, nextOffset: hasMore ? offset + results.length : null, ranker: 'engine' as MemoryRanker,
    entities: results.query.entities.map((entity): LinkedEntity => ({ id: entity.id, name: entity.name, surface: entity.surface })) };
}
