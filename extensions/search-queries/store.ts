/**
 * Raw search log: one row per engine + normalised query, the distinct searches that made it,
 * and the results opened from it. Sources are built from these rows by index.ts.
 * The tables have no access-profile row filter, so scoped consumers see only the sources.
 */
import type { Database } from "bun:sqlite";
import {
  cleanUrl, queryKey, type AiOverview, type Engine, type SearchQueryRecord, type SearchResult, type SearchVisitRecord,
} from "./contract";

export interface QueryRow {
  engine: Engine;
  query_key: string;
  query: string;
  first_searched_at: number;
  last_searched_at: number;
  search_count: number;
  ai_overview: string | null;
  ai_overview_at: number | null;
  results: string;
  dirty_at: number | null;
  source_id: string | null;
}

export interface VisitRow {
  url: string;
  title: string | null;
  description: string | null;
  rank: number | null;
  first_visited_at: number;
  last_visited_at: number;
  visit_count: number;
}

export function searchTables(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS search_queries (
    engine TEXT NOT NULL, query_key TEXT NOT NULL, query TEXT NOT NULL,
    first_searched_at INTEGER NOT NULL, last_searched_at INTEGER NOT NULL, search_count INTEGER NOT NULL DEFAULT 0,
    ai_overview TEXT CHECK(ai_overview IS NULL OR json_valid(ai_overview)), ai_overview_at INTEGER,
    results TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(results)), results_at INTEGER,
    dirty_at INTEGER, source_id TEXT,
    PRIMARY KEY(engine, query_key)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS search_queries_dirty ON search_queries(dirty_at) WHERE dirty_at IS NOT NULL;
  CREATE TABLE IF NOT EXISTS search_events (
    search_id TEXT PRIMARY KEY, engine TEXT NOT NULL, query_key TEXT NOT NULL, searched_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS search_visits (
    engine TEXT NOT NULL, query_key TEXT NOT NULL, url TEXT NOT NULL, title TEXT, description TEXT, rank INTEGER,
    first_visited_at INTEGER NOT NULL, last_visited_at INTEGER NOT NULL, visit_count INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY(engine, query_key, url)
  ) STRICT`);
  return db;
}

/** Count a search once however many of its records arrive, and mark its query for indexing. */
function noteSearch(db: Database, engine: Engine, query: string, searchId: string, at: number, now: number) {
  const key = queryKey(query);
  db.query(`INSERT INTO search_queries(engine,query_key,query,first_searched_at,last_searched_at,dirty_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(engine,query_key) DO UPDATE SET dirty_at=excluded.dirty_at`)
    .run(engine, key, query, at, at, now);
  const added = db.query("INSERT OR IGNORE INTO search_events VALUES(?,?,?,?)").run(searchId, engine, key, at).changes;
  if (added) db.query(`UPDATE search_queries SET search_count=search_count+1,
      first_searched_at=min(first_searched_at,?1), last_searched_at=max(last_searched_at,?1),
      query=CASE WHEN ?1>=last_searched_at THEN ?2 ELSE query END
    WHERE engine=?3 AND query_key=?4`).run(at, query, engine, key);
  return key;
}

/** A results page: the newest capture's results and AI Overview win. */
export function recordSearch(db: Database, record: SearchQueryRecord, keepOverview: boolean, now = Date.now()) {
  const key = noteSearch(db, record.engine, record.query, record.searchId, record.searchedAt, now);
  db.query(`UPDATE search_queries SET results=?, results_at=? WHERE engine=? AND query_key=?
    AND (results_at IS NULL OR results_at<=?)`)
    .run(JSON.stringify(record.results), record.searchedAt, record.engine, key, record.searchedAt);
  if (keepOverview && record.aiOverview) db.query(`UPDATE search_queries SET ai_overview=?, ai_overview_at=?
    WHERE engine=? AND query_key=? AND (ai_overview_at IS NULL OR ai_overview_at<=?)`)
    .run(JSON.stringify(record.aiOverview), record.searchedAt, record.engine, key, record.searchedAt);
}

/** A result opened from a search; opening it again updates the same row. */
export function recordVisit(db: Database, record: SearchVisitRecord, now = Date.now()) {
  const key = noteSearch(db, record.engine, record.query, record.searchId, record.searchedAt ?? record.visitedAt, now);
  db.query(`INSERT INTO search_visits(engine,query_key,url,title,description,rank,first_visited_at,last_visited_at)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?7) ON CONFLICT(engine,query_key,url) DO UPDATE SET
      title=coalesce(excluded.title,title), description=coalesce(excluded.description,description),
      rank=coalesce(excluded.rank,rank), first_visited_at=min(first_visited_at,excluded.first_visited_at),
      last_visited_at=max(last_visited_at,excluded.last_visited_at), visit_count=visit_count+1`)
    .run(record.engine, key, cleanUrl(record.url), record.title?.trim() || null, record.description?.trim() || null,
      record.rank ?? null, record.visitedAt);
}

export function dueQueries(db: Database, before: number, limit: number) {
  return db.query<QueryRow, [number, number]>(
    "SELECT * FROM search_queries WHERE dirty_at IS NOT NULL AND dirty_at<=? ORDER BY dirty_at LIMIT ?").all(before, limit);
}

export function visitsFor(db: Database, row: Pick<QueryRow, "engine" | "query_key">) {
  return db.query<VisitRow, [string, string]>(`SELECT url,title,description,rank,first_visited_at,last_visited_at,visit_count
    FROM search_visits WHERE engine=? AND query_key=? ORDER BY last_visited_at DESC, url`).all(row.engine, row.query_key);
}

/** Clear the mark only if nothing newer arrived while the source was being written. */
export function markIndexed(db: Database, row: QueryRow, sourceId: string | null) {
  db.query("UPDATE search_queries SET dirty_at=CASE WHEN dirty_at=? THEN NULL ELSE dirty_at END, source_id=? WHERE engine=? AND query_key=?")
    .run(row.dirty_at, sourceId, row.engine, row.query_key);
}

export const overviewOf = (row: QueryRow): AiOverview | undefined => row.ai_overview ? JSON.parse(row.ai_overview) : undefined;
export const resultsOf = (row: QueryRow): SearchResult[] => JSON.parse(row.results);
