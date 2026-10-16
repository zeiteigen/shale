import type { Database, SQLQueryBindings } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { DEFAULT_FIELD_WEIGHTS, SEARCH_FIELDS, type SearchField } from './contracts';
import { boilerplateStripper, countSource, ensureBoilerplateTables, lineHashes, markStripped, producerOf, producersToRestrip } from './boilerplate';
import { sourceKeyphrases } from '../../lib/text/terms';
import { acronymKeys } from '../../lib/graph/identity-keys';
import { isRegistryType } from '../graph/registry';
import { ensureAccessSchema } from '../../lib/access/schema';
import { readAccessPolicy, type AccessPolicy } from '../../lib/access/policy';
import { recordTier } from '../../lib/access/visibility';

/**
 * The fielded, source-level search index (BM25F-style): one row per source in `source_search_fts`, columns in
 * SEARCH_FIELDS order, so `bm25(source_search_fts, ...weights)` weighs a title or entity-name match above a body match.
 * - title: sources.title;
 * - entities: names, plain/search/source aliases, and acronyms of the registry entities linked to the source (the
 *   anchor text of web search: "UWHPC" finds sources that only spell the name out, and the reverse);
 * - keyphrases: corpus-aware keyphrases (lib/text/terms.ts);
 * - summary: the summary without its extractive "Coverage:" overview (which repeats snippet text);
 * - body: retained snippets with producer boilerplate removed (sdk/retrieval/boilerplate.ts).
 * `source_search_trigram` indexes title + entities by trigrams for partial words and typos ("waterlo").
 * Both are contentless FTS5 tables keyed by search_docs.id; the indexer is incremental and bounded.
 *
 * Access control. The FTS tables are passthrough in scoped connections (FTS5 MATCH cannot run through a view), so
 * every query joins search_docs → sources, whose shadow views drop rows the profile cannot see. The entities field
 * could still name an entity the profile cannot see inside a source it can: names come only from entities whose
 * effective tier is at most the source's own and that are grounded in this source (or nowhere), so whoever sees the
 * source sees them. Each contributing entity is recorded in search_doc_entities, and the search_docs shadow filter
 * hides a document while any of them is invisible to the profile, which closes the window between a label or policy
 * change and the reindex that follows it.
 */

const EXCLUDED_TYPES = new Set(['Episode', 'Source', 'ChatSession', 'Conversation', 'WebPage']);
const NAME_SCOPES = `(scope='' OR scope='search' OR scope GLOB 'source:*' OR scope='key:acronym')`;
const MAX_ENTITIES_CHARS = 4000;
const SUMMARY_EXTRACTIVE_CHARS = 400;
const STATE = 'search-index';

export function ensureSearchIndex(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS search_docs (
    id INTEGER PRIMARY KEY, source_id TEXT UNIQUE NOT NULL, memory_version INTEGER, entity_stamp TEXT, indexed_at INTEGER) STRICT`);
  db.run(`CREATE TABLE IF NOT EXISTS search_doc_entities (
    doc_id INTEGER NOT NULL, entity_id INTEGER NOT NULL, PRIMARY KEY(doc_id,entity_id)) STRICT, WITHOUT ROWID`);
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS source_search_fts USING fts5(${SEARCH_FIELDS.join(', ')},
    content='', contentless_delete=1, tokenize='porter unicode61 remove_diacritics 2')`);
  // Stores its (small) text: typo candidates are re-ranked by trigram overlap with the words actually indexed.
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS source_search_trigram USING fts5(title, entities, tokenize='trigram')`);
  ensureBoilerplateTables(db);
  if (!hasTable(db, 'graph_access_labels')) ensureAccessSchema(db);
}

const hasTable = (db: Database, name: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const sha = (value: string) => createHash('sha1').update(value).digest('base64url').slice(0, 22);

/** Summary text without the extractive overview: a model summary is kept whole, an extractive-only one is cut short. */
export function searchSummary(summary: string): string {
  const coverage = summary.indexOf('\n\nCoverage:');
  if (coverage >= 0) return summary.slice(0, coverage).trim();
  const extractive = /^Extractive overview of [^\n]*:\n/.exec(summary);
  if (!extractive) return summary.trim();
  const points = summary.slice(extractive[0].length).split('\n').map(line => line.replace(/^•\s*/, '')).join('\n');
  return points.slice(0, SUMMARY_EXTRACTIVE_CHARS).trim();
}

/**
 * Graph state the entity field depends on, loaded once per run: canonical groups, record versions, label stamps,
 * and source links. The entity stamp of a source hashes everything its field could change with.
 */
export class EntityContext {
  readonly root = new Map<number, number>();
  readonly members = new Map<number, number[]>();
  readonly linked = new Set<number>();
  private versions = new Map<number, number>();
  private labels = new Map<string, string>();
  private links = new Map<string, Set<number>>();
  private titles = new Map<string, string>();
  private selfRoot: number | null = null;
  private policyKey: string;
  private tierCache = new Map<number, number>();
  private names = new Map<number, { type: string; namespace: string; names: string[]; retired: boolean }>();

  constructor(private db: Database, readonly policy: AccessPolicy = readAccessPolicy(), sourceIds?: string[]) {
    const parent = new Map<number, number | null>();
    for (const row of db.query<{ id: number; canonical_id: number | null }, []>('SELECT id,canonical_id FROM entities').all())
      parent.set(row.id, row.canonical_id);
    for (const id of parent.keys()) {
      let current = id;
      const seen = new Set<number>();
      while (parent.get(current) != null && !seen.has(current)) { seen.add(current); current = parent.get(current)!; }
      this.root.set(id, current);
      const list = this.members.get(current) ?? [];
      list.push(id);
      this.members.set(current, list);
    }
    if (hasTable(db, 'graph_record_versions'))
      for (const row of db.query<{ record_id: string; version: number }, []>("SELECT record_id,version FROM graph_record_versions WHERE kind='entity'").all())
        this.versions.set(Number(row.record_id), row.version);
    for (const row of db.query<{ kind: string; record_id: string; stamp: string }, []>(
      "SELECT kind,record_id,group_concat(origin||tier||'@'||updated_at) AS stamp FROM graph_access_labels WHERE kind IN ('entity','source') GROUP BY kind,record_id").all())
      this.labels.set(`${row.kind}:${row.record_id}`, row.stamp);
    const only = sourceIds ? ` WHERE source_id IN (SELECT value FROM json_each(?))` : '';
    const bind: SQLQueryBindings[] = sourceIds ? [JSON.stringify(sourceIds), JSON.stringify(sourceIds)] : [];
    for (const row of db.query<{ source_id: string; entity_id: number }, SQLQueryBindings[]>(`SELECT source_id,entity_id FROM source_entities${only}
      UNION SELECT c.source_id,ce.entity_id FROM chunk_entities ce JOIN chunks c ON c.id=ce.chunk_id${only.replace('source_id', 'c.source_id')}`).all(...bind)) {
      const set = this.links.get(row.source_id) ?? new Set();
      set.add(row.entity_id);
      this.links.set(row.source_id, set);
    }
    // "Grounded nowhere" needs every link, not only the requested sources'.
    for (const row of db.query<{ entity_id: number }, []>('SELECT entity_id FROM source_entities UNION SELECT entity_id FROM chunk_entities').all())
      this.linked.add(row.entity_id);
    for (const row of db.query<{ id: string; title: string }, SQLQueryBindings[]>(`SELECT id,title FROM sources${sourceIds ? ' WHERE id IN (SELECT value FROM json_each(?))' : ''}`)
      .all(...(sourceIds ? [JSON.stringify(sourceIds)] : []))) this.titles.set(row.id, row.title);
    const self = db.query<{ id: number }, []>("SELECT id FROM entities WHERE stable_id='self'").get()?.id;
    this.selfRoot = self === undefined ? null : this.root.get(self) ?? self;
    this.policyKey = JSON.stringify([this.policy.defaultTier, this.policy.originTiers, this.policy.tierRules]);
  }

  /** Canonical groups linked to a source (the self group excluded). */
  groups(sourceId: string): number[] {
    const roots = new Set<number>();
    for (const id of this.links.get(sourceId) ?? []) {
      const root = this.root.get(id) ?? id;
      if (root !== this.selfRoot) roots.add(root);
    }
    return [...roots].sort((a, b) => a - b);
  }

  stamp(sourceId: string): string {
    const links = [...(this.links.get(sourceId) ?? [])].sort((a, b) => a - b);
    const groups = this.groups(sourceId).map(root => (this.members.get(root) ?? [root])
      .map(id => `${id}:${this.versions.get(id) ?? 0}:${this.labels.get(`entity:${id}`) ?? ''}`).join(','));
    return sha(JSON.stringify([this.titles.get(sourceId) ?? '', this.labels.get(`source:${sourceId}`) ?? '', this.policyKey, links, groups]));
  }

  tier(id: number): number {
    let tier = this.tierCache.get(id);
    if (tier === undefined) { tier = recordTier(this.db, this.policy, 'entity', String(id)) ?? 3; this.tierCache.set(id, tier); }
    return tier;
  }

  entity(id: number) {
    let entry = this.names.get(id);
    if (entry) return entry;
    const row = this.db.query<{ name: string; display_name: string | null; type: string; namespace: string }, [number]>(
      'SELECT name,display_name,type,namespace FROM entities WHERE id=?').get(id);
    const retired = hasTable(this.db, 'graph_entity_retirements') && !!this.db.query('SELECT 1 FROM graph_entity_retirements WHERE entity_id=?').get(id);
    const names: string[] = [];
    if (row) {
      for (const name of [row.display_name, row.name]) if (name && !/^entity:/.test(name)) names.push(name);
      for (const alias of this.db.query<{ alias: string; scope: string }, [number]>(`SELECT alias,scope FROM graph_aliases WHERE entity_id=? AND ${NAME_SCOPES}`).all(id))
        names.push(alias.scope === 'key:acronym' ? alias.alias.toUpperCase() : alias.alias);
    }
    entry = { type: row?.type ?? '', namespace: row?.namespace ?? '', names: names.filter(usableName), retired };
    this.names.set(id, entry);
    return entry;
  }

  /** Whether an entity has any grounding at all (links or claim evidence); ungrounded registry entries are public to the group. */
  grounded(id: number): boolean {
    if (this.linked.has(id)) return true;
    return !!this.db.query(`SELECT 1 FROM graph_claims c JOIN graph_evidence ev ON ev.claim_id=c.id WHERE c.subject_id=?1 OR c.object_id=?1 LIMIT 1`).get(id);
  }

  sourceLinks(sourceId: string): Set<number> { return this.links.get(sourceId) ?? new Set(); }
}

/** Identifiers and URLs stored as aliases are not names. */
function usableName(name: string) {
  const value = name.trim();
  return value.length > 1 && value.length <= 200 && !/:\/\//.test(value) && !/^[a-z-]+:[0-9a-f-]{12,}/i.test(value);
}

function searchableEntity(entry: { type: string; namespace: string; retired: boolean }) {
  if (entry.retired || EXCLUDED_TYPES.has(entry.type) || !isRegistryType(entry.type)) return false;
  // Connector records of conversations, visits, and searches are events too, but not something a query names.
  return !(entry.type === 'Event' && entry.namespace !== 'knowledge');
}

/**
 * The entities field: for each linked canonical group, the names of members that are registry-typed, at most as
 * sensitive as the source, and grounded in this source (or nowhere). Returns the text and the contributing ids.
 */
export function entityField(context: EntityContext, sourceId: string, sourceTier: number): { text: string; entities: number[] } {
  const links = context.sourceLinks(sourceId);
  const seen = new Set<string>();
  const parts: string[] = [];
  const contributing: number[] = [];
  let length = 0;
  const add = (value: string) => {
    const key = value.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key) || length > MAX_ENTITIES_CHARS) return;
    seen.add(key);
    parts.push(value.trim());
    length += value.length + 3;
  };
  for (const root of context.groups(sourceId)) {
    const members = context.members.get(root) ?? [root];
    // Linked members first, then the canonical, then the rest of the group.
    const ordered = [...members].sort((a, b) => Number(links.has(b)) - Number(links.has(a)) || Number(b === root) - Number(a === root) || a - b);
    for (const id of ordered) {
      const entry = context.entity(id);
      if (!searchableEntity(entry) || !entry.names.length) continue;
      if (!links.has(id) && context.grounded(id)) continue;
      if (context.tier(id) > sourceTier) continue;
      contributing.push(id);
      for (const name of entry.names) {
        add(name);
        for (const acronym of acronymKeys(name)) add(acronym.toUpperCase());
      }
    }
  }
  return { text: parts.join(' ; '), entities: contributing };
}

export interface SearchDoc { sourceId: string; memoryVersion: number; stamp: string; fields: Record<SearchField, string>; entities: number[]; removedLines: number }

interface SourceRow { id: string; title: string; origin: string; uri: string; version: number | null }

function sourceTexts(db: Database, sourceId: string) {
  const rows = db.query<{ chunk_index: number; text_content: string }, [string]>(
    'SELECT chunk_index,text_content FROM chunks WHERE source_id=? ORDER BY chunk_index,id').all(sourceId);
  return { summary: rows.find(row => row.chunk_index === 0)?.text_content ?? '', snippets: rows.filter(row => row.chunk_index > 0).map(row => row.text_content) };
}

/** Build one source's document (no writes). `strippers` caches a stripper per producer for the run. */
export function buildSearchDoc(db: Database, source: SourceRow, context: EntityContext, strippers = new Map<string, ReturnType<typeof boilerplateStripper>>()): SearchDoc {
  const { summary, snippets } = sourceTexts(db, source.id);
  const raw = snippets.join('\n');
  const producer = producerOf(source, raw);
  let stripper = strippers.get(producer);
  if (!stripper) { stripper = boilerplateStripper(db, producer); strippers.set(producer, stripper); }
  const stripped = stripper(raw);
  const sourceTier = recordTier(db, context.policy, 'source', source.id) ?? 3;
  const entities = entityField(context, source.id, sourceTier);
  const summaryText = searchSummary(summary);
  let keyphrases = '';
  try {
    keyphrases = sourceKeyphrases(db, source.id, [source.title, summaryText, stripped.text].join('\n\n'), { max: 12 }).map(k => k.phrase).join(' ; ');
  } catch { /* phrase statistics not built yet */ }
  return {
    sourceId: source.id, memoryVersion: source.version ?? 0, stamp: context.stamp(source.id), entities: entities.entities, removedLines: stripped.removed,
    fields: { title: source.title, entities: entities.text, keyphrases, summary: summaryText, body: stripped.text },
  };
}

function writeDoc(db: Database, doc: SearchDoc) {
  const id = db.query<{ id: number }, [string, number, string, number]>(`INSERT INTO search_docs(source_id,memory_version,entity_stamp,indexed_at) VALUES(?,?,?,?)
    ON CONFLICT(source_id) DO UPDATE SET memory_version=excluded.memory_version,entity_stamp=excluded.entity_stamp,indexed_at=excluded.indexed_at
    RETURNING id`).get(doc.sourceId, doc.memoryVersion, doc.stamp, Date.now())!.id;
  db.query('DELETE FROM source_search_fts WHERE rowid=?').run(id);
  db.query('DELETE FROM source_search_trigram WHERE rowid=?').run(id);
  db.query(`INSERT INTO source_search_fts(rowid,${SEARCH_FIELDS.join(',')}) VALUES(?,${SEARCH_FIELDS.map(() => '?').join(',')})`)
    .run(id, ...SEARCH_FIELDS.map(field => doc.fields[field]));
  db.query('INSERT INTO source_search_trigram(rowid,title,entities) VALUES(?,?,?)').run(id, doc.fields.title, doc.fields.entities);
  db.query('DELETE FROM search_doc_entities WHERE doc_id=?').run(id);
  const link = db.query('INSERT OR IGNORE INTO search_doc_entities(doc_id,entity_id) VALUES(?,?)');
  for (const entity of doc.entities) link.run(id, entity);
}

function deleteDoc(db: Database, id: number) {
  db.query('DELETE FROM source_search_fts WHERE rowid=?').run(id);
  db.query('DELETE FROM source_search_trigram WHERE rowid=?').run(id);
  db.query('DELETE FROM search_doc_entities WHERE doc_id=?').run(id);
  db.query('DELETE FROM search_docs WHERE id=?').run(id);
}

/** Changes the entity stamps could depend on: graph writes, access labels, and the policy's tier floors. */
function changeSignature(db: Database, policy: AccessPolicy) {
  const graph = hasTable(db, 'graph_record_versions')
    ? db.query<{ v: number }, []>("SELECT coalesce(max(version),0) AS v FROM graph_record_versions WHERE kind='database'").get()!.v : 0;
  const labels = db.query<{ s: string }, []>("SELECT count(*)||':'||coalesce(max(updated_at),0)||':'||coalesce(sum(updated_at),0) AS s FROM graph_access_labels").get()!.s;
  return sha(JSON.stringify([graph, labels, policy.defaultTier, policy.originTiers, policy.tierRules]));
}

const getState = (db: Database, key: string) =>
  db.query<{ value: string }, [string, string]>('SELECT value FROM extension_state WHERE extension_id=? AND state_key=?').get(STATE, key)?.value;
const setState = (db: Database, key: string, value: string) =>
  db.query(`INSERT INTO extension_state(extension_id,state_key,value,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(extension_id,state_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(STATE, key, value, Date.now());

export interface IndexOptions {
  /** Documents (re)built per call. */
  limit?: number;
  /** Wall-clock budget in ms. */
  deadlineMs?: number;
  /** Only these sources (the `source:ingested` path); otherwise every source that changed. */
  sourceIds?: string[];
  /** Documents per write transaction. */
  batch?: number;
  policy?: AccessPolicy;
}

export interface IndexResult { indexed: number; deleted: number; counted: number; restripped: number; pending: number; removedLines: number; restamped: boolean }

/**
 * Incremental indexing: count boilerplate lines for new or changed sources, flag producers whose cut-off moved,
 * then (re)build documents whose memory version or entity stamp changed, or that are new, and delete documents of
 * removed sources. Entity stamps are recomputed only when graph writes, labels, or the policy changed since the last
 * complete pass (the watermark). Short transactions; returns how much is still pending.
 */
export function indexSources(db: Database, options: IndexOptions = {}): IndexResult {
  ensureSearchIndex(db);
  const started = Date.now();
  const deadline = started + (options.deadlineMs ?? 20_000);
  const limit = options.limit ?? 500;
  const batch = options.batch ?? 25;
  const policy = options.policy ?? readAccessPolicy();
  const only = options.sourceIds;
  const result: IndexResult = { indexed: 0, deleted: 0, counted: 0, restripped: 0, pending: 0, removedLines: 0, restamped: false };
  const filter = only ? ' AND s.id IN (SELECT value FROM json_each(?))' : '';
  const bind: SQLQueryBindings[] = only ? [JSON.stringify(only)] : [];

  // 1. Removed sources.
  if (!only) {
    const gone = db.query<{ id: number }, []>('SELECT d.id FROM search_docs d WHERE NOT EXISTS(SELECT 1 FROM sources s WHERE s.id=d.source_id)').all();
    const uncounted = db.query<{ source_id: string }, []>('SELECT b.source_id FROM search_boilerplate_docs b WHERE NOT EXISTS(SELECT 1 FROM sources s WHERE s.id=b.source_id)').all();
    db.transaction(() => {
      for (const row of gone) deleteDoc(db, row.id);
      for (const row of uncounted) countSource(db, row.source_id, null);
    })();
    result.deleted = gone.length;
  }

  // 2. Boilerplate statistics for new or changed sources (cheap: line hashes only), before any document is built.
  for (;;) {
    const rows = db.query<SourceRow, SQLQueryBindings[]>(`SELECT s.id,s.title,s.origin,s.uri,m.version FROM sources s
      LEFT JOIN source_memories m ON m.source_id=s.id LEFT JOIN search_boilerplate_docs b ON b.source_id=s.id
      WHERE (b.source_id IS NULL OR b.memory_version<>coalesce(m.version,0))${filter} LIMIT 500`).all(...bind);
    if (!rows.length) break;
    db.transaction(() => {
      for (const row of rows) {
        const body = sourceTexts(db, row.id).snippets.join('\n');
        countSource(db, row.id, { producer: producerOf(row, body), memoryVersion: row.version ?? 0, hashes: lineHashes(body) });
      }
    })();
    result.counted += rows.length;
    if (Date.now() > deadline) { result.pending = 1; return result; }
  }

  // 3. A producer that grew enough has a new cut-off: its documents are stripped again.
  if (!only) db.transaction(() => {
    for (const producer of producersToRestrip(db)) {
      result.restripped += db.query(`UPDATE search_docs SET memory_version=-1 WHERE source_id IN
        (SELECT source_id FROM search_boilerplate_docs WHERE producer=?)`).run(producer).changes;
      markStripped(db, producer);
    }
  })();

  // 4. Which documents to build.
  const signature = changeSignature(db, policy);
  const restamp = !!only || getState(db, 'signature') !== signature;
  result.restamped = restamp && !only;
  const context = new EntityContext(db, policy, only);
  const candidates = db.query<SourceRow & { doc_version: number | null; entity_stamp: string | null; doc: number | null }, SQLQueryBindings[]>(
    `SELECT s.id,s.title,s.origin,s.uri,m.version,d.id AS doc,d.memory_version AS doc_version,d.entity_stamp FROM sources s
     LEFT JOIN source_memories m ON m.source_id=s.id LEFT JOIN search_docs d ON d.source_id=s.id WHERE 1${filter}
     ORDER BY d.id IS NOT NULL, s.updated_at DESC`).all(...bind);
  const pending = candidates.filter(row => row.doc === null || row.doc_version !== (row.version ?? 0)
    || (restamp && row.entity_stamp !== context.stamp(row.id)));

  // 5. Build and write, a few documents per transaction.
  const strippers = new Map<string, ReturnType<typeof boilerplateStripper>>();
  let done = 0;
  for (let i = 0; i < pending.length && done < limit; i += batch) {
    if (Date.now() > deadline) break;
    const slice = pending.slice(i, Math.min(i + batch, i + limit - done));
    const docs = slice.map(row => buildSearchDoc(db, row, context, strippers));
    db.transaction(() => { for (const doc of docs) writeDoc(db, doc); })();
    done += docs.length;
    result.removedLines += docs.reduce((sum, doc) => sum + doc.removedLines, 0);
  }
  result.indexed = done;
  result.pending = pending.length - done;
  if (!only && result.pending === 0 && restamp) setState(db, 'signature', signature);
  return result;
}

export interface FieldSearchFilters { origin?: string; type?: string; sourceId?: string }
export interface FieldSearchHit { sourceId: string; docId: number; bm25: number; fieldHits?: SearchField[] }

const weightList = (weights: Partial<Record<SearchField, number>> = {}) => SEARCH_FIELDS.map(field => weights[field] ?? DEFAULT_FIELD_WEIGHTS[field]);

function filterSql(filters: FieldSearchFilters = {}, bindings: SQLQueryBindings[]) {
  const parts: string[] = [];
  if (filters.origin) { parts.push('s.origin=?'); bindings.push(filters.origin); }
  if (filters.type) { parts.push('s.type=?'); bindings.push(filters.type); }
  if (filters.sourceId) { parts.push('(s.id=? OR s.uri=?)'); bindings.push(filters.sourceId, filters.sourceId); }
  return parts.length ? ` AND ${parts.join(' AND ')}` : '';
}

/**
 * Field-weighted BM25 over the source index (lower is better, as with bm25()). `match` is an FTS5 expression built
 * by the caller. Joined through search_docs → sources, so a scoped connection only returns visible sources.
 * `fieldHits` reports which fields matched for each returned hit (one extra MATCH per field over the page).
 */
export function searchFields(db: Database, match: string, options: { weights?: Partial<Record<SearchField, number>>; limit?: number; filters?: FieldSearchFilters; fieldHits?: boolean } = {}): FieldSearchHit[] {
  const bindings: SQLQueryBindings[] = [match];
  const where = filterSql(options.filters, bindings);
  const weights = weightList(options.weights);
  const hits = db.query<FieldSearchHit, SQLQueryBindings[]>(`SELECT d.source_id AS sourceId,d.id AS docId,bm25(source_search_fts,${weights.join(',')}) AS bm25
    FROM source_search_fts JOIN search_docs d ON d.id=source_search_fts.rowid JOIN sources s ON s.id=d.source_id
    WHERE source_search_fts MATCH ?${where} ORDER BY bm25 LIMIT ?`).all(...bindings, options.limit ?? 100);
  if (options.fieldHits && hits.length) {
    const ids = JSON.stringify(hits.map(hit => hit.docId));
    const byDoc = new Map(hits.map(hit => [hit.docId, (hit.fieldHits = [] as SearchField[])]));
    for (const field of SEARCH_FIELDS) {
      for (const row of db.query<{ id: number }, [string, string]>(`SELECT rowid AS id FROM source_search_fts
        WHERE source_search_fts MATCH ? AND rowid IN (SELECT value FROM json_each(?))`).all(`{${field}} : (${match})`, ids))
        byDoc.get(row.id)?.push(field);
    }
  }
  return hits;
}

const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;

const trigrams = (word: string) => { const set = new Set<string>(); for (let i = 0; i + 3 <= word.length; i++) set.add(word.slice(i, i + 3)); return set; };
const fold = (text: string) => text.toLocaleLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');

const bigrams = (word: string) => { const set = new Set<string>(); for (let i = 0; i + 2 <= word.length; i++) set.add(word.slice(i, i + 2)); return set; };

/** Best bigram Dice similarity of a query word to any word of the text (1 for a substring of one); bigrams, unlike
 *  trigrams, survive a transposition ("watreloo" ~ "waterloo" 0.57). */
function wordSimilarity(word: string, grams: Set<string>, words: string[]) {
  let best = 0;
  for (const candidate of words) {
    if (candidate.includes(word)) return 1;
    if (Math.abs(candidate.length - word.length) > Math.max(2, word.length / 2)) continue;
    const other = bigrams(candidate);
    let shared = 0;
    for (const gram of grams) if (other.has(gram)) shared++;
    best = Math.max(best, 2 * shared / (grams.size + other.size));
  }
  return best;
}

/**
 * Typo- and prefix-tolerant candidates from titles and entity names: each query word (3+ characters) matches as a
 * substring, and its trigrams match separately, so "waterlo" and "watreloo" both reach "Waterloo". FTS5 gathers up to
 * `pool` rows; they are re-ranked by how well each query word matches an indexed word (bigram Dice), and rows where
 * no word reaches `minSimilarity` are dropped. Score: higher is better.
 */
export function trigramCandidates(db: Database, text: string, limit = 50, filters?: FieldSearchFilters,
  options: { pool?: number; minSimilarity?: number } = {}): Array<{ sourceId: string; docId: number; score: number }> {
  const words = [...new Set(fold(text).split(/[^\p{L}\p{N}]+/u).filter(word => word.length >= 3))];
  const terms = new Set<string>();
  for (const word of words) { terms.add(word); if (word.length > 4) for (const gram of trigrams(word)) terms.add(gram); }
  if (!terms.size) return [];
  const bindings: SQLQueryBindings[] = [[...terms].map(quote).join(' OR ')];
  const where = filterSql(filters, bindings);
  const rows = db.query<{ sourceId: string; docId: number; title: string; entities: string }, SQLQueryBindings[]>(`SELECT d.source_id AS sourceId,d.id AS docId,
    source_search_trigram.title AS title,source_search_trigram.entities AS entities
    FROM source_search_trigram JOIN search_docs d ON d.id=source_search_trigram.rowid JOIN sources s ON s.id=d.source_id
    WHERE source_search_trigram MATCH ?${where} ORDER BY bm25(source_search_trigram,2,1) LIMIT ?`).all(...bindings, options.pool ?? 500);
  const minimum = options.minSimilarity ?? 0.5;
  const grams = words.map(bigrams);
  return rows.map((row, rank) => {
    const indexed = [...new Set(fold(`${row.title} ${row.entities}`).split(/[^\p{L}\p{N}]+/u).filter(word => word.length >= 3))];
    const similarities = words.map((word, i) => wordSimilarity(word, grams[i]!, indexed));
    // Mean similarity over query words; a whole-title hit outranks an entity-name hit through the FTS rank tiebreak.
    const score = similarities.reduce((sum, value) => sum + value, 0) / words.length - rank * 1e-6;
    return { sourceId: row.sourceId, docId: row.docId, score, best: Math.max(...similarities) };
  }).filter(row => row.best >= minimum).sort((a, b) => b.score - a.score).slice(0, limit)
    .map(({ sourceId, docId, score }) => ({ sourceId, docId, score }));
}
