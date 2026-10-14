import type { Database } from 'bun:sqlite';
import { ensureStorySchema } from '../../lib/graph/story-schema';
import { AFFILIATION_KEY_KINDS, emailKeys, identityKeys, keyScope, urlKeys, type IdentityKey } from '../../lib/graph/identity-keys';
import { REGISTRY_FAMILIES, typeFamily } from '../../lib/graph/ontology';

/**
 * The registry is the set of canonical entities a model may link a mention to: people, organizations,
 * projects, artifacts, episodes, and so on. It is indexed by identity keys (graph_aliases scope `key:*`)
 * and by entity_registry_fts for lexical shortlists. Merged entities contribute names to their canonical.
 */
export interface RegistryEntry { id: number; name: string; type: string; description: string; basis: string[] }

/** Follow canonical_id to the identity that currently represents an entity. */
export function canonicalOf(db: Database, id: number): number {
  const seen = new Set<number>();
  let current = id;
  for (;;) {
    const row = db.query<{ canonical_id: number | null }, [number]>('SELECT canonical_id FROM entities WHERE id=?').get(current);
    if (!row || row.canonical_id === null || seen.has(current)) return current;
    seen.add(current);
    current = row.canonical_id;
  }
}

export function writeKeys(db: Database, entityId: number, keys: IdentityKey[]) {
  const insert = db.query('INSERT OR IGNORE INTO graph_aliases(entity_id,alias,scope) VALUES(?,?,?)');
  for (const key of keys) if (key.value.trim()) insert.run(entityId, key.value.trim(), keyScope(key.kind));
}

export function keysOf(db: Database, entityId: number): IdentityKey[] {
  return db.query<{ alias: string; scope: string }, [number]>(
    "SELECT alias,scope FROM graph_aliases WHERE entity_id=? AND scope GLOB 'key:*' AND scope!='key:none'").all(entityId)
    .map(row => ({ kind: row.scope.slice(4), value: row.alias }));
}

/** Canonical entities that carry any of the given keys, with the keys that matched. */
export function entitiesWithKeys(db: Database, keys: IdentityKey[], exclude?: number): Map<number, IdentityKey[]> {
  const found = new Map<number, IdentityKey[]>();
  const query = db.query<{ entity_id: number }, [string, string]>(`SELECT a.entity_id FROM graph_aliases a
    WHERE a.alias=? AND a.scope=? AND NOT EXISTS(SELECT 1 FROM graph_entity_retirements r WHERE r.entity_id=a.entity_id)`);
  const excluded = exclude === undefined ? undefined : canonicalOf(db, exclude);
  // Domains are shared by whole sites; looking them up would fan out to every page of github.com.
  const lookups = keys.filter(key => !AFFILIATION_KEY_KINDS.has(key.kind) && key.kind !== 'none');
  for (const key of lookups) for (const row of query.all(key.value, keyScope(key.kind))) {
    const id = canonicalOf(db, row.entity_id);
    if (id === excluded) continue;
    const list = found.get(id) ?? [];
    if (!list.some(item => item.kind === key.kind && item.value === key.value)) list.push(key);
    found.set(id, list);
  }
  return found;
}

/** Keys implied by a connector entity's own connector key (accounts, guilds, URLs) and its names. */
export function connectorKeys(db: Database, entityId: number): IdentityKey[] {
  const entity = db.query<{ type: string; name: string }, [number]>(
    'SELECT type,coalesce(display_name,name) AS name FROM entities WHERE id=?').get(entityId);
  if (!entity) return [];
  const connector = db.query<{ alias: string }, [number]>(
    "SELECT alias FROM graph_aliases WHERE entity_id=? AND scope='connector-key'").all(entityId).map(row => row.alias);
  const keys: IdentityKey[] = [];
  for (const key of connector) {
    let match: RegExpExecArray | null;
    if ((match = /^discord:\/\/guild\/(\d+)$/.exec(key))) keys.push({ kind: 'discord-guild', value: match[1]! });
    else if ((match = /^discord:user:(\d+)$/.exec(key))) keys.push({ kind: 'discord-user', value: match[1]! });
    else if ((match = /^email:user:(.+)$/.exec(key))) keys.push(...emailKeys(match[1]!));
    else if (/^https?:\/\//.test(key)) keys.push(...urlKeys(key));
  }
  const family = typeFamily(entity.type);
  // Pages and sessions are identified by URL, not by their titles.
  if (['Person', 'Community', 'Organization'].includes(family) && entity.name)
    keys.push(...identityKeys({ names: [entity.name] }));
  return keys;
}

const MAX_TEXT = 4000;

function registryText(db: Database, id: number): string {
  const members = db.query<{ id: number }, [number]>(`WITH RECURSIVE m(id) AS (SELECT ? UNION SELECT e.id FROM entities e JOIN m ON e.canonical_id=m.id)
    SELECT id FROM m`).all(id).map(row => row.id);
  const placeholders = members.map(() => '?').join(',');
  const names = db.query<{ alias: string }, number[]>(`SELECT DISTINCT alias FROM graph_aliases WHERE entity_id IN (${placeholders})
    AND (scope='' OR scope='search' OR scope GLOB 'source:*' OR scope IN ('key:github','key:linkedin','key:gitlab'))`).all(...members)
    .map(row => row.alias);
  const description = describe(db, id);
  const episode = db.query<{ summary: string }, [number]>('SELECT summary FROM graph_episodes WHERE entity_id=?').get(id)?.summary ?? '';
  return [...new Set(names), description, episode].filter(Boolean).join(' • ').slice(0, MAX_TEXT);
}

/** The most recent model description of an entity, if any. */
export function describe(db: Database, id: number): string {
  const row = db.query<{ value_json: string }, [number]>(`SELECT value_json FROM graph_claims WHERE subject_id IN
    (WITH RECURSIVE m(id) AS (SELECT ?1 UNION SELECT e.id FROM entities e JOIN m ON e.canonical_id=m.id) SELECT id FROM m)
    AND predicate='DESCRIPTION' AND status IN ('accepted','proposed') ORDER BY recorded_at DESC LIMIT 1`).get(id);
  if (!row) return '';
  try { const value = JSON.parse(row.value_json); return typeof value === 'string' ? value : ''; } catch { return ''; }
}

export function isRegistryType(type: string) {
  return REGISTRY_FAMILIES.has(typeFamily(type));
}

/** Refresh one entity's registry row (and its canonical's, when it was merged). */
export function indexEntity(db: Database, id: number) {
  ensureStorySchema(db);
  const canonical = canonicalOf(db, id);
  if (canonical !== id) db.query('DELETE FROM entity_registry_fts WHERE rowid=?').run(id);
  const entity = db.query<{ type: string }, [number]>(`SELECT type FROM entities e WHERE id=?
    AND NOT EXISTS(SELECT 1 FROM graph_entity_retirements r WHERE r.entity_id=e.id)`).get(canonical);
  db.query('DELETE FROM entity_registry_fts WHERE rowid=?').run(canonical);
  if (!entity || !isRegistryType(entity.type)) return;
  // Connector records of conversations and visits are events too, but not things a mention can name.
  if (entity.type === 'Event' && db.query('SELECT 1 FROM graph_events WHERE entity_id=?').get(canonical)) return;
  db.query('INSERT INTO entity_registry_fts(rowid,text) VALUES(?,?)').run(canonical, registryText(db, canonical));
}

/**
 * Index canonical registry-type entities with ids above `afterId`, at most `limit` per call, in one short
 * transaction. Returns the last id examined, or null when done. Callers loop, yielding between batches,
 * so a first build over a large graph never holds the write lock long enough to starve other jobs.
 */
export function rebuildRegistryBatch(db: Database, afterId = 0, limit = 500): number | null {
  ensureStorySchema(db);
  const rows = db.query<{ id: number; type: string }, [number, number]>(`SELECT id,type FROM entities e WHERE id>? AND canonical_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM graph_entity_retirements r WHERE r.entity_id=e.id) ORDER BY id LIMIT ?`).all(afterId, limit);
  if (!rows.length) return null;
  db.transaction(() => {
    if (afterId === 0) db.run('DELETE FROM entity_registry_fts');
    for (const row of rows) if (isRegistryType(row.type)) indexEntity(db, row.id);
  })();
  return rows.at(-1)!.id;
}

/** Index every canonical registry-type entity (tests and scripts; the resolver cron uses batches). */
export function rebuildRegistry(db: Database) {
  for (let after: number | null = 0; after !== null;) after = rebuildRegistryBatch(db, after, 1000);
}

const QUERY_STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'you', 'your', 'are', 'was', 'were',
  'have', 'has', 'not', 'but', 'all', 'can', 'will', 'just', 'about', 'into', 'out', 'our', 'their', 'there', 'what',
  'when', 'which', 'who', 'how', 'also', 'more', 'some', 'any', 'one', 'its', 'they', 'them', 'been', 'would', 'could',
  'http', 'https', 'www', 'com']);

/** Distinct query terms from free text, preferring capitalised and unusual tokens. */
export function queryTerms(texts: string[], limit = 48): string[] {
  const scored = new Map<string, number>();
  for (const text of texts) for (const match of text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}_-]{1,40}/gu)) {
    const token = match[0];
    const lower = token.toLowerCase();
    if (lower.length < 3 || QUERY_STOPWORDS.has(lower) || /^\d+$/.test(lower)) continue;
    const weight = (/\p{Lu}{2}/u.test(token) ? 3 : /^\p{Lu}/u.test(token) ? 2 : 1) + (/\d/.test(token) ? 0.5 : 0);
    scored.set(lower, Math.max(scored.get(lower) ?? 0, weight) + 0.01);
  }
  return [...scored.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([term]) => term);
}

function ftsQuery(terms: string[]) {
  return terms.map(term => `"${term.replace(/"/g, '""')}"`).join(' OR ');
}

function entry(db: Database, id: number, basis: string[]): RegistryEntry | null {
  const row = db.query<{ name: string; type: string }, [number]>(
    'SELECT coalesce(display_name,name) AS name,type FROM entities WHERE id=?').get(id);
  return row ? { id, name: row.name, type: row.type, description: describe(db, id), basis } : null;
}

/**
 * Shortlist registry entities for a model prompt: key matches first, then BM25 over registry text.
 * A single OR query lets FTS5's IDF favour rare terms such as "nhpc" over common ones.
 */
export function shortlist(db: Database, options: { keys?: IdentityKey[]; texts?: string[]; limit?: number;
  types?: string[]; excludeTypes?: string[]; exclude?: number[] }): RegistryEntry[] {
  ensureStorySchema(db);
  const limit = options.limit ?? 15;
  const excluded = new Set(options.exclude ?? []);
  const result = new Map<number, RegistryEntry>();
  const allow = (type: string) => (!options.types || options.types.includes(type)) && !options.excludeTypes?.includes(type);
  for (const [id, matched] of entitiesWithKeys(db, options.keys ?? [])) {
    if (result.size >= limit || excluded.has(id)) continue;
    const found = entry(db, id, matched.map(key => `${key.kind}:${key.value}`));
    if (found && allow(found.type) && isRegistryType(found.type)) result.set(id, found);
  }
  const terms = queryTerms(options.texts ?? []);
  if (terms.length && result.size < limit) {
    // Type filters belong in SQL: otherwise frequent types fill the candidate window and rarer ones never surface.
    const types = options.types ?? [], skippedTypes = options.excludeTypes ?? [];
    const rows = db.query<{ id: number }, Array<string | number>>(`SELECT f.rowid AS id FROM entity_registry_fts f
      JOIN entities e ON e.id=f.rowid WHERE entity_registry_fts MATCH ? AND e.canonical_id IS NULL
      ${types.length ? `AND e.type IN (${types.map(() => '?').join(',')})` : ''}
      ${skippedTypes.length ? `AND e.type NOT IN (${skippedTypes.map(() => '?').join(',')})` : ''}
      ORDER BY bm25(entity_registry_fts) LIMIT ?`).all(ftsQuery(terms), ...types, ...skippedTypes, limit * 3);
    for (const row of rows) {
      if (result.size >= limit) break;
      if (result.has(row.id) || excluded.has(row.id)) continue;
      const found = entry(db, row.id, ['text']);
      if (found && allow(found.type)) result.set(row.id, found);
    }
  }
  return [...result.values()];
}
