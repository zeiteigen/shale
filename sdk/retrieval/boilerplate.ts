import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { lineKey } from '../../lib/graph/templates';

/**
 * Boilerplate stripping for the fielded search index (sdk/retrieval/indexer.ts). Bulk senders and sites repeat the
 * same footers, legal lines, "unsubscribe" text, and greeting scaffolding in every source; indexed as body text they
 * inflate BM25 for every query that touches them. A line is boilerplate for its *producer* (mail sender address,
 * else page host, else origin) when it appears in more than `maxShare` of that producer's sources, once the producer
 * has at least `minDocs` sources. Line document frequencies are kept incrementally: each counted source stores the
 * hashes it contributed, so a changed or removed source subtracts exactly what it added.
 * The constant lines of induced email templates (graph_email_templates, extensions/knowledge-extractor/templates.ts)
 * are dropped too, without waiting for a sender to accumulate sources.
 * Operational tables only: no shadowFilters entry, so restricted profiles never see them.
 */

export const BOILERPLATE = { maxShare: 0.3, minDocs: 5, minKey: 4 } as const;

export function ensureBoilerplateTables(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS search_boilerplate (
    producer TEXT NOT NULL, line_hash TEXT NOT NULL, df INTEGER NOT NULL, PRIMARY KEY(producer,line_hash)) STRICT, WITHOUT ROWID`);
  // docs: sources counted for the producer; stripped_docs: the count when its indexed sources were last re-stripped.
  db.run(`CREATE TABLE IF NOT EXISTS search_boilerplate_producers (
    producer TEXT PRIMARY KEY, docs INTEGER NOT NULL, stripped_docs INTEGER NOT NULL DEFAULT 0) STRICT`);
  db.run(`CREATE TABLE IF NOT EXISTS search_boilerplate_docs (
    source_id TEXT PRIMARY KEY, producer TEXT NOT NULL, memory_version INTEGER NOT NULL, hashes TEXT NOT NULL) STRICT`);
  db.run('CREATE INDEX IF NOT EXISTS search_boilerplate_docs_producer ON search_boilerplate_docs(producer)');
}

/** Comparison key of a line: links masked, digits collapsed, case and spacing folded ('' when too short to judge). */
export function boilerplateKey(line: string): string {
  const key = lineKey(line).toLowerCase().replace(/\d+/g, '#');
  return key.length >= BOILERPLATE.minKey ? key : '';
}

const hashKey = (key: string) => createHash('sha1').update(key).digest('base64url').slice(0, 16);

/** Distinct line hashes of a text, for document frequency. */
export function lineHashes(text: string): string[] {
  const hashes = new Set<string>();
  for (const line of text.split('\n')) { const key = boilerplateKey(line); if (key) hashes.add(hashKey(key)); }
  return [...hashes];
}

const SENDER = /^\[\d{1,2}:\d{2}\]\s[^\n<]*<([^<>\s@]+@[^<>\s]+)>:/m;
const FROM = /^From:[^\n]*?<?([^<>\s@:]+@[^<>\s]+?)>?\s*$/im;

/** Who produced a source's text: the first mail sender's address, else the page host, else the origin. */
export function producerOf(source: { origin: string; uri: string }, text: string, participants: string[] = []): string {
  const sender = SENDER.exec(text)?.[1] ?? FROM.exec(text)?.[1] ?? participants.find(p => p.includes('@'));
  if (sender && (source.origin === 'email' || /^email:/.test(source.uri) || participants.length)) return `email:${sender.toLowerCase()}`;
  try {
    const url = new URL(source.uri);
    if (/^https?:$/.test(url.protocol) && url.hostname) return `host:${url.hostname.replace(/^www\./, '').toLowerCase()}`;
  } catch { /* not a URL */ }
  return `origin:${source.origin}`;
}

/** Update document frequencies for one source (replacing what it contributed before); null removes it. */
export function countSource(db: Database, sourceId: string, next: { producer: string; memoryVersion: number; hashes: string[] } | null) {
  const prior = db.query<{ producer: string; hashes: string }, [string]>('SELECT producer,hashes FROM search_boilerplate_docs WHERE source_id=?').get(sourceId);
  if (prior) {
    const minus = db.query('UPDATE search_boilerplate SET df=df-1 WHERE producer=? AND line_hash=?');
    for (const hash of JSON.parse(prior.hashes) as string[]) minus.run(prior.producer, hash);
    db.query('DELETE FROM search_boilerplate WHERE producer=? AND df<=0').run(prior.producer);
    db.query('UPDATE search_boilerplate_producers SET docs=docs-1 WHERE producer=?').run(prior.producer);
    db.query('DELETE FROM search_boilerplate_docs WHERE source_id=?').run(sourceId);
  }
  if (!next) return;
  const plus = db.query(`INSERT INTO search_boilerplate(producer,line_hash,df) VALUES(?,?,1)
    ON CONFLICT(producer,line_hash) DO UPDATE SET df=df+1`);
  for (const hash of next.hashes) plus.run(next.producer, hash);
  db.query(`INSERT INTO search_boilerplate_producers(producer,docs) VALUES(?,1)
    ON CONFLICT(producer) DO UPDATE SET docs=docs+1`).run(next.producer);
  db.query('INSERT INTO search_boilerplate_docs(source_id,producer,memory_version,hashes) VALUES(?,?,?,?)')
    .run(sourceId, next.producer, next.memoryVersion, JSON.stringify(next.hashes));
}

/** Producers whose source count grew enough since their sources were last stripped that the cut-off may have moved. */
export function producersToRestrip(db: Database): string[] {
  return db.query<{ producer: string }, [number]>(`SELECT producer FROM search_boilerplate_producers
    WHERE docs>=? AND docs>=stripped_docs*1.25+1`).all(BOILERPLATE.minDocs).map(row => row.producer);
}

export function markStripped(db: Database, producer: string) {
  db.query('UPDATE search_boilerplate_producers SET stripped_docs=docs WHERE producer=?').run(producer);
}

const hasTable = (db: Database, name: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

/** Constant line keys of a sender's active email templates (P2), compared with lineKey(). */
export function templateConstants(db: Database, producer: string): Set<string> {
  const keys = new Set<string>();
  if (!producer.startsWith('email:') || !hasTable(db, 'graph_email_templates')) return keys;
  const rows = db.query<{ wrapper: string }, [string]>("SELECT wrapper FROM graph_email_templates WHERE sender=? AND status='active'")
    .all(producer.slice('email:'.length));
  for (const row of rows) {
    try {
      const wrapper = JSON.parse(row.wrapper) as { items?: Array<{ kind: string; key?: string }> };
      for (const item of wrapper.items ?? []) if (item.kind === 'const' && item.key) keys.add(item.key);
    } catch { /* malformed wrapper: nothing constant */ }
  }
  return keys;
}

/**
 * A stripper for one producer: drops lines above the share cut-off and template constants. Returns the text and
 * how many lines were removed.
 */
export function boilerplateStripper(db: Database, producer: string) {
  const docs = db.query<{ docs: number }, [string]>('SELECT docs FROM search_boilerplate_producers WHERE producer=?').get(producer)?.docs ?? 0;
  const frequent = new Set<string>();
  if (docs >= BOILERPLATE.minDocs) for (const row of db.query<{ line_hash: string }, [string, number]>(
    'SELECT line_hash FROM search_boilerplate WHERE producer=? AND df>?').all(producer, docs * BOILERPLATE.maxShare)) frequent.add(row.line_hash);
  const constants = templateConstants(db, producer);
  return (text: string): { text: string; removed: number } => {
    if (!frequent.size && !constants.size) return { text, removed: 0 };
    let removed = 0;
    const kept = text.split('\n').filter(line => {
      const key = boilerplateKey(line);
      const drop = (key && frequent.has(hashKey(key))) || (constants.size && constants.has(lineKey(line)));
      if (drop) removed++;
      return !drop;
    });
    return { text: kept.join('\n').replace(/\n{3,}/g, '\n\n'), removed };
  };
}
