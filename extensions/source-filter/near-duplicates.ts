import type { Database } from 'bun:sqlite';
import { bands, hamming, parseSimhash, simhash, simhashHex } from '../../lib/text/simhash';
import { words } from '../../lib/text/tokenize';
import type { SourceFeatures } from './features';
import type { FilterSource } from './types';

/** Fingerprints of short texts collide by template alone ("Thanks!"); only bodies this long are compared. */
const MIN_WORDS = 25;
/** Upper bound on band-matched candidates compared per source, so one mass mailing cannot make a scan quadratic. */
const MAX_CANDIDATES = 400;

/**
 * Who produced the content: the transcript author for chat-shaped sources (emails, DMs), else the page host.
 * Near-duplicates only count within one origin and producer — the same template from one sender is bulk mail,
 * while two people quoting the same article are not.
 */
export function producerKey(source: FilterSource): string {
  const raw = (source.memory?.snippets ?? []).filter(snippet => snippet.kind === 'excerpt').map(snippet => snippet.text).join('\n');
  const author = raw.match(/^\s*(?:•\s*)?\[\d{2}:\d{2}\]\s+([^\n]{1,120}?):\s/m)?.[1];
  const producer = author ? (author.match(/<([^>]+@[^>]+)>/)?.[1] ?? author) : (source.uri.match(/^https?:\/\/(?:www\.)?([^/:?#]+)/i)?.[1] ?? '');
  return `${source.origin}\u001f${producer.trim().toLocaleLowerCase()}`;
}

/**
 * SimHash index over retained excerpts (private operational state; never shown to scoped profiles).
 * Rows are banded so lookups use equality indexes; distance ≤ 3 is exhaustive by pigeonhole.
 */
export class NearDuplicates {
  constructor(private db: Database) {
    db.run(`CREATE TABLE IF NOT EXISTS source_filter_simhash (
      source_id TEXT PRIMARY KEY, producer TEXT NOT NULL, hash TEXT NOT NULL,
      b0 INTEGER NOT NULL, b1 INTEGER NOT NULL, b2 INTEGER NOT NULL, b3 INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS source_filter_simhash_b0 ON source_filter_simhash(producer,b0);
    CREATE INDEX IF NOT EXISTS source_filter_simhash_b1 ON source_filter_simhash(producer,b1);
    CREATE INDEX IF NOT EXISTS source_filter_simhash_b2 ON source_filter_simhash(producer,b2);
    CREATE INDEX IF NOT EXISTS source_filter_simhash_b3 ON source_filter_simhash(producer,b3);`);
  }

  /** Record this source's fingerprint and count other live sources from the same producer within `distance` bits. */
  observe(source: FilterSource, features: SourceFeatures, distance = 3): number {
    const body = features.payloadLines.join('\n');
    if (words(body).length < MIN_WORDS) { this.forget(source.id); return 0; }
    const hash = simhash(body);
    if (!hash) return 0;
    const producer = producerKey(source), [b0, b1, b2, b3] = bands(hash);
    this.db.query(`INSERT INTO source_filter_simhash(source_id,producer,hash,b0,b1,b2,b3,updated_at) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(source_id) DO UPDATE SET producer=excluded.producer,hash=excluded.hash,b0=excluded.b0,b1=excluded.b1,
        b2=excluded.b2,b3=excluded.b3,updated_at=excluded.updated_at`).run(source.id, producer, simhashHex(hash), b0, b1, b2, b3, Date.now());
    const candidates = this.db.query<{ hash: string }, Record<string, string | number>>(`
      SELECT h.hash FROM source_filter_simhash h JOIN sources s ON s.id=h.source_id
      WHERE h.source_id IN (SELECT source_id FROM source_filter_simhash WHERE producer=$producer AND b0=$b0
        UNION SELECT source_id FROM source_filter_simhash WHERE producer=$producer AND b1=$b1
        UNION SELECT source_id FROM source_filter_simhash WHERE producer=$producer AND b2=$b2
        UNION SELECT source_id FROM source_filter_simhash WHERE producer=$producer AND b3=$b3) AND h.source_id!=$id
      LIMIT ${MAX_CANDIDATES}`).all({ $producer: producer, $b0: b0, $b1: b1, $b2: b2, $b3: b3, $id: source.id });
    return candidates.filter(candidate => hamming(hash, parseSimhash(candidate.hash)) <= Math.min(3, distance)).length;
  }

  forget(sourceId: string) {
    this.db.query('DELETE FROM source_filter_simhash WHERE source_id=?').run(sourceId);
  }
}
