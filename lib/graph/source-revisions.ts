import type { Database } from "bun:sqlite";
import { ensureMemorySchema } from '../memory/schema';

/** Snapshots survive source replacement/deletion and chunk-ID reuse. */
export function installRevisionTracking(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS graph_source_revisions (
      id INTEGER PRIMARY KEY, source_id TEXT NOT NULL, hash TEXT NOT NULL,
      uri TEXT NOT NULL, title TEXT NOT NULL, captured_at INTEGER NOT NULL, original_source_id TEXT, original_hash TEXT,
      UNIQUE(source_id,hash)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS graph_evidence (
      id TEXT PRIMARY KEY, claim_id TEXT NOT NULL REFERENCES graph_claims(id),
      revision_id INTEGER NOT NULL REFERENCES graph_source_revisions(id), chunk_index INTEGER,
      stance TEXT NOT NULL CHECK(stance IN ('supports','contradicts','mentions')),
      locator TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(locator)), quote TEXT,
      method TEXT NOT NULL, model TEXT, confidence REAL CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS graph_evidence_claim ON graph_evidence(claim_id);
    CREATE INDEX IF NOT EXISTS graph_evidence_revision ON graph_evidence(revision_id);
  `);
  const revisionColumns=new Set(db.query<{name:string},[]>('PRAGMA table_info(graph_source_revisions)').all().map(c=>c.name));
  for(const column of ['original_source_id','original_hash']) if(!revisionColumns.has(column))
    db.run(`ALTER TABLE graph_source_revisions ADD COLUMN ${column} TEXT`);
  ensureMemorySchema(db);
  if (!db.query("SELECT 1 FROM sqlite_master WHERE name='sources'").get() ||
      !db.query("SELECT 1 FROM sqlite_master WHERE name='chunks'").get()) return;
  const columns = db.query<{name: string}, []>("PRAGMA table_info(chunks)").all();
  if (!columns.some(c => c.name === 'chunk_type'))
    db.run("ALTER TABLE chunks ADD COLUMN chunk_type TEXT NOT NULL DEFAULT 'verbatim'");
  const updateTrigger = db.query<{sql:string},[]>("SELECT sql FROM sqlite_master WHERE name='graph_source_update'").get();
  if (updateTrigger && (!updateTrigger.sql.includes('external-source-change') || updateTrigger.sql.includes('r.hash=OLD.hash'))) db.run('DROP TRIGGER graph_source_update');
  db.run(`
    INSERT OR IGNORE INTO graph_source_revisions(source_id,hash,uri,title,captured_at)
      SELECT id,hash,uri,title,updated_at FROM sources;
    INSERT OR IGNORE INTO graph_revision_chunks(revision_id,chunk_index,chunk_type,text_content)
      SELECT r.id,c.chunk_index,c.chunk_type,c.text_content FROM chunks c JOIN sources s ON s.id=c.source_id
      JOIN graph_source_revisions r ON r.source_id=s.id AND r.hash=s.hash;
    CREATE TRIGGER IF NOT EXISTS graph_source_snapshot AFTER INSERT ON sources BEGIN
      INSERT OR IGNORE INTO graph_source_revisions(source_id,hash,uri,title,captured_at)
        VALUES(NEW.id,NEW.hash,NEW.uri,NEW.title,NEW.updated_at);
    END;
    CREATE TRIGGER IF NOT EXISTS graph_source_update AFTER UPDATE ON sources WHEN OLD.hash != NEW.hash BEGIN
      INSERT OR IGNORE INTO graph_source_revisions(source_id,hash,uri,title,captured_at)
        VALUES(NEW.id,NEW.hash,NEW.uri,NEW.title,NEW.updated_at);
      UPDATE graph_claims SET status='stale' WHERE status IN ('accepted','proposed','disputed') AND id IN (
        SELECT e.claim_id FROM graph_evidence e JOIN graph_source_revisions r ON r.id=e.revision_id
        WHERE r.source_id=OLD.id AND e.stance='supports'
        AND NOT EXISTS(SELECT 1 FROM source_memory_write_intents intent JOIN source_revision_fingerprints f
          JOIN source_memories m ON m.source_id=OLD.id WHERE intent.source_id=OLD.id AND intent.hash=NEW.hash
          AND f.revision_id=r.id AND f.fingerprint=m.fingerprint)
      );
      UPDATE source_memories SET fingerprint='external-source-change:'||NEW.hash,availability='refresh-required'
        WHERE source_id=OLD.id AND NOT EXISTS(SELECT 1 FROM source_memory_write_intents intent WHERE intent.source_id=OLD.id AND intent.hash=NEW.hash);
    END;
    CREATE TRIGGER IF NOT EXISTS graph_source_delete BEFORE DELETE ON sources BEGIN
      UPDATE graph_claims SET status='stale' WHERE status IN ('accepted','proposed','disputed') AND id IN (
        SELECT e.claim_id FROM graph_evidence e JOIN graph_source_revisions r ON r.id=e.revision_id
        WHERE r.source_id=OLD.id AND e.stance='supports'
      );
    END;
    CREATE TRIGGER IF NOT EXISTS graph_chunk_snapshot AFTER INSERT ON chunks BEGIN
      INSERT OR IGNORE INTO graph_revision_chunks(revision_id,chunk_index,chunk_type,text_content)
        SELECT r.id,NEW.chunk_index,NEW.chunk_type,NEW.text_content FROM sources s
        JOIN graph_source_revisions r ON r.source_id=s.id AND r.hash=s.hash WHERE s.id=NEW.source_id;
    END;
  `);
}
