import type { Database } from 'bun:sqlite';

/** Text is stored once; immutable revision passages contain references and provenance. */
export function ensureMemorySchema(db: Database): void {
  if (db.query("SELECT 1 FROM sqlite_master WHERE name='chunk_entities' AND type='table'").get())
    db.run('CREATE INDEX IF NOT EXISTS chunk_entities_entity ON chunk_entities(entity_id,chunk_id)');
  db.run(`CREATE TABLE IF NOT EXISTS graph_memory_texts (
    id INTEGER PRIMARY KEY, text_content TEXT NOT NULL UNIQUE
  ) STRICT;
  CREATE TABLE IF NOT EXISTS graph_revision_passages (
    id INTEGER PRIMARY KEY, revision_id INTEGER NOT NULL REFERENCES graph_source_revisions(id),
    chunk_index INTEGER NOT NULL, text_id INTEGER NOT NULL REFERENCES graph_memory_texts(id),
    chunk_type TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'excerpt', snippet_id TEXT,
    locator TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(locator)),
    UNIQUE(revision_id,chunk_index)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS graph_passage_text ON graph_revision_passages(text_id);
  CREATE TABLE IF NOT EXISTS source_revision_fingerprints (
    revision_id INTEGER PRIMARY KEY REFERENCES graph_source_revisions(id), fingerprint TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS source_memory_write_intents (source_id TEXT PRIMARY KEY, hash TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS source_memory_pins (
    owner TEXT NOT NULL, passage_id INTEGER NOT NULL REFERENCES graph_revision_passages(id), expires_at INTEGER NOT NULL,
    PRIMARY KEY(owner,passage_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS source_memory_discarded (
    revision_id INTEGER NOT NULL, chunk_index INTEGER NOT NULL, fingerprint TEXT NOT NULL, characters INTEGER NOT NULL,
    reason TEXT NOT NULL, PRIMARY KEY(revision_id,chunk_index)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS source_memories (
    source_id TEXT PRIMARY KEY, version INTEGER NOT NULL, fingerprint TEXT NOT NULL,
    summary_version INTEGER NOT NULL REFERENCES graph_revision_passages(id),
    summary_method TEXT NOT NULL, coverage TEXT NOT NULL CHECK(json_valid(coverage)),
    availability TEXT NOT NULL DEFAULT 'retained', updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS source_snippets (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL, current_version INTEGER NOT NULL REFERENCES graph_revision_passages(id),
    purpose TEXT NOT NULL, retired INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS source_snippet_source ON source_snippets(source_id,retired);
  CREATE TABLE IF NOT EXISTS source_observations (
    id INTEGER PRIMARY KEY, source_id TEXT NOT NULL, fingerprint TEXT NOT NULL, captured_at INTEGER NOT NULL,
    origin TEXT NOT NULL, availability TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata))
  ) STRICT;
  CREATE INDEX IF NOT EXISTS source_observation_recent ON source_observations(source_id,id DESC);
  CREATE TABLE IF NOT EXISTS source_entities (
    source_id TEXT NOT NULL, entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
    PRIMARY KEY(source_id,entity_id)
  ) STRICT;
  CREATE INDEX IF NOT EXISTS source_entities_entity ON source_entities(entity_id,source_id);
  CREATE TABLE IF NOT EXISTS source_memory_changes (
    id INTEGER PRIMARY KEY, source_id TEXT NOT NULL, version INTEGER NOT NULL, actor TEXT NOT NULL,
    reason TEXT NOT NULL, request_id TEXT UNIQUE, fingerprint TEXT NOT NULL, result TEXT NOT NULL CHECK(json_valid(result)), created_at INTEGER NOT NULL
  ) STRICT;`);
  if(!db.query<{name:string},[]>('PRAGMA table_info(source_observations)').all().some(c=>c.name==='metadata'))
    db.run("ALTER TABLE source_observations ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata))");
  const legacy = db.query<{type:string}, []>("SELECT type FROM sqlite_master WHERE name='graph_revision_chunks'").get();
  if (legacy?.type === 'table') db.transaction(() => {
    db.run('DROP TRIGGER IF EXISTS graph_chunk_snapshot');
    db.run(`INSERT INTO graph_memory_texts(text_content) SELECT DISTINCT text_content FROM graph_revision_chunks WHERE true
      ON CONFLICT(text_content) DO NOTHING;
      INSERT INTO graph_revision_passages(revision_id,chunk_index,text_id,chunk_type)
        SELECT c.revision_id,c.chunk_index,t.id,c.chunk_type FROM graph_revision_chunks c
        JOIN graph_memory_texts t ON t.text_content=c.text_content WHERE true ON CONFLICT(revision_id,chunk_index) DO NOTHING;
      DROP TABLE graph_revision_chunks;`);
  })();
  db.run(`CREATE VIEW IF NOT EXISTS graph_revision_chunks AS
    SELECT p.revision_id,p.chunk_index,p.chunk_type,t.text_content FROM graph_revision_passages p JOIN graph_memory_texts t ON t.id=p.text_id;
    CREATE TRIGGER IF NOT EXISTS graph_revision_chunk_insert INSTEAD OF INSERT ON graph_revision_chunks BEGIN
      INSERT INTO graph_memory_texts(text_content) VALUES(NEW.text_content) ON CONFLICT(text_content) DO NOTHING;
      INSERT INTO graph_revision_passages(revision_id,chunk_index,text_id,chunk_type)
        SELECT NEW.revision_id,NEW.chunk_index,id,NEW.chunk_type FROM graph_memory_texts WHERE text_content=NEW.text_content
        ON CONFLICT(revision_id,chunk_index) DO NOTHING;
    END;
    CREATE TRIGGER IF NOT EXISTS graph_revision_chunk_delete INSTEAD OF DELETE ON graph_revision_chunks BEGIN
      DELETE FROM graph_revision_passages WHERE revision_id=OLD.revision_id AND chunk_index=OLD.chunk_index;
    END;`);
  if(db.query("SELECT 1 FROM sqlite_master WHERE name='chunks'").get()) db.run(`
    CREATE TRIGGER IF NOT EXISTS memory_source_delete AFTER DELETE ON sources BEGIN
      DELETE FROM source_snippets WHERE source_id=OLD.id;
      DELETE FROM source_memories WHERE source_id=OLD.id;
      DELETE FROM source_entities WHERE source_id=OLD.id;
      DELETE FROM source_observations WHERE source_id=OLD.id;
    END;
    CREATE TRIGGER IF NOT EXISTS memory_chunk_insert_budget BEFORE INSERT ON chunks
      WHEN length(NEW.text_content)>CASE WHEN NEW.chunk_index=0 AND NEW.chunk_type='synthetic' THEN 8000 ELSE 1200 END
      BEGIN SELECT RAISE(ABORT,'Source text must be prepared as bounded summary/snippets'); END;
    CREATE TRIGGER IF NOT EXISTS memory_chunk_update_budget BEFORE UPDATE OF text_content ON chunks
      WHEN length(NEW.text_content)>CASE WHEN NEW.chunk_index=0 AND NEW.chunk_type='synthetic' THEN 8000 ELSE 1200 END
      BEGIN SELECT RAISE(ABORT,'Source text must be prepared as bounded summary/snippets'); END;`);
}
