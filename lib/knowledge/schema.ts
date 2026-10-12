import type { Database } from "bun:sqlite";

/** Editing history is independent of live records and survives removal. */
export function ensureKnowledgeEditingSchema(db: Database) {
  const migrated=Boolean(db.query("SELECT 1 FROM sqlite_master WHERE name='graph_migrations'").get() &&
    db.query("SELECT 1 FROM graph_migrations WHERE name='knowledge-editing-v2'").get());
  if(migrated && db.query("SELECT 1 FROM sqlite_temp_master WHERE name='knowledge_edit_session'").get() &&
    db.query("SELECT 1 FROM sqlite_master WHERE name='knowledge_event_title_version'").get()) return;
  db.run(`
    CREATE TABLE IF NOT EXISTS graph_changes (
      id TEXT PRIMARY KEY, request_id TEXT UNIQUE, fingerprint TEXT NOT NULL,
      actor TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL,
      operations TEXT NOT NULL CHECK(json_valid(operations)),
      result TEXT NOT NULL CHECK(json_valid(result))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS graph_record_versions (
      kind TEXT NOT NULL, record_id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(kind,record_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS graph_evidence_history (
      evidence_id TEXT PRIMARY KEY, replacement_id TEXT, actor TEXT NOT NULL,
      reason TEXT NOT NULL, withdrawn_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS graph_source_archives (
      source_id TEXT PRIMARY KEY, snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
      actor TEXT NOT NULL, reason TEXT NOT NULL, removed_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS graph_source_exclusions (
      identity TEXT PRIMARY KEY, source_id TEXT NOT NULL, actor TEXT NOT NULL,
      reason TEXT NOT NULL, created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS graph_source_metadata (
      source_id TEXT PRIMARY KEY, metadata TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata))
    ) STRICT;
  `);
  db.run("CREATE TEMP TABLE IF NOT EXISTS knowledge_edit_journal(kind TEXT NOT NULL,record_id TEXT NOT NULL,event TEXT NOT NULL DEFAULT '')");
  db.run('CREATE TEMP TABLE IF NOT EXISTS knowledge_edit_session(id INTEGER PRIMARY KEY,active INTEGER NOT NULL)');
  db.run('INSERT INTO knowledge_edit_session VALUES(1,0) ON CONFLICT(id) DO NOTHING');
  for(const name of ['graph_source_update','graph_source_delete']) {
    const trigger=db.query<{sql:string},[string]>('SELECT sql FROM sqlite_master WHERE name=?').get(name);
    if(trigger && !trigger.sql.includes('graph_evidence_history')) {
      db.run(`DROP TRIGGER ${name}`);
      db.run(trigger.sql.replace("e.stance='supports'","e.stance='supports' AND NOT EXISTS(SELECT 1 FROM graph_evidence_history h WHERE h.evidence_id=e.id)"));
    }
  }
  if (db.query("SELECT 1 FROM sqlite_master WHERE name='sources'").get()) {
    db.run(`CREATE TRIGGER IF NOT EXISTS knowledge_source_exclusion_insert BEFORE INSERT ON sources
      WHEN EXISTS(SELECT 1 FROM graph_source_exclusions WHERE identity=NEW.uri OR identity='id:'||NEW.id)
      BEGIN SELECT RAISE(ABORT,'SOURCE_EXCLUDED'); END;
      CREATE TRIGGER IF NOT EXISTS knowledge_source_exclusion_update BEFORE UPDATE ON sources
      WHEN EXISTS(SELECT 1 FROM graph_source_exclusions WHERE identity=NEW.uri OR identity='id:'||NEW.id)
      BEGIN SELECT RAISE(ABORT,'SOURCE_EXCLUDED'); END;`);
  }
  // Track external writers too; optimistic checks cannot depend on MCP-only writes.
  for (const [table, kind, key] of [
    ['entities','entity','id'], ['graph_claims','claim','id'], ['graph_evidence','evidence','id'],
    ['graph_events','event','entity_id'], ['sources','source','id'], ['chunks','chunk','id'],
  ]) {
    if (!db.query('SELECT 1 FROM sqlite_master WHERE name=?').get(table!)) continue;
    for (const event of ['INSERT','UPDATE','DELETE']) {
      const row = event === 'DELETE' ? 'OLD' : 'NEW';
      const triggerName=`knowledge_version_${table}_${event.toLowerCase()}`;
      const existing=db.query<{sql:string},[string]>('SELECT sql FROM sqlite_master WHERE name=?').get(triggerName);
      if(existing && !existing.sql.includes("VALUES('database','*',1)")) db.run(`DROP TRIGGER ${triggerName}`);
      db.run(`CREATE TRIGGER IF NOT EXISTS knowledge_version_${table}_${event.toLowerCase()} AFTER ${event} ON ${table}
        BEGIN INSERT INTO graph_record_versions(kind,record_id,version) VALUES('${kind}',CAST(${row}.${key} AS TEXT),1)
        ON CONFLICT(kind,record_id) DO UPDATE SET version=version+1;
        INSERT INTO graph_record_versions(kind,record_id,version) VALUES('database','*',1)
        ON CONFLICT(kind,record_id) DO UPDATE SET version=version+1; END;`);
      db.run(`DROP TRIGGER IF EXISTS temp.knowledge_journal_${table}_${event.toLowerCase()}`);
      db.run(`CREATE TEMP TRIGGER knowledge_journal_${table}_${event.toLowerCase()} AFTER ${event} ON main.${table}
        WHEN (SELECT active FROM knowledge_edit_session WHERE id=1)=1
        BEGIN INSERT INTO knowledge_edit_journal VALUES('${kind}',CAST(${row}.${key} AS TEXT),'${event[0]}'); END;`);
    }
    if(!migrated) db.run(`INSERT INTO graph_record_versions(kind,record_id,version)
      SELECT '${kind}',CAST(${key} AS TEXT),1 FROM ${table} WHERE true ON CONFLICT(kind,record_id) DO NOTHING`);
  }
  for(const [table,kind,key] of [
    ['graph_aliases','entity','entity_id'],['graph_dependencies','claim','claim_id'],
    ['graph_claim_links','claim','source_id'],['graph_participants','event','event_id'],
    ['graph_evidence_history','evidence','evidence_id'],['graph_source_metadata','source','source_id'],
    ['chunk_entities','chunk','chunk_id'],['graph_source_archives','source','source_id'],
    ['graph_source_exclusions','source','source_id'],['graph_relations','relation','name'],
  ]) {
    if(!db.query('SELECT 1 FROM sqlite_master WHERE name=?').get(table!)) continue;
    for(const event of ['INSERT','UPDATE','DELETE']) {
      const row=event==='DELETE' ? 'OLD' : 'NEW';
      db.run(`CREATE TRIGGER IF NOT EXISTS knowledge_side_version_${table}_${event.toLowerCase()} AFTER ${event} ON ${table}
        BEGIN INSERT INTO graph_record_versions(kind,record_id,version) VALUES('${kind}',CAST(${row}.${key} AS TEXT),1)
        ON CONFLICT(kind,record_id) DO UPDATE SET version=version+1;
        INSERT INTO graph_record_versions(kind,record_id,version) VALUES('database','*',1)
        ON CONFLICT(kind,record_id) DO UPDATE SET version=version+1; END;`);
      db.run(`DROP TRIGGER IF EXISTS temp.knowledge_side_journal_${table}_${event.toLowerCase()}`);
      db.run(`CREATE TEMP TRIGGER knowledge_side_journal_${table}_${event.toLowerCase()} AFTER ${event} ON main.${table}
        WHEN (SELECT active FROM knowledge_edit_session WHERE id=1)=1
        BEGIN INSERT INTO knowledge_edit_journal VALUES('${kind}',CAST(${row}.${key} AS TEXT),'${event[0]}'); END;`);
    }
  }
  if(db.query("SELECT 1 FROM sqlite_master WHERE name='graph_events'").get())
    db.run(`CREATE TRIGGER IF NOT EXISTS knowledge_event_title_version AFTER UPDATE OF name,display_name ON entities
      WHEN EXISTS(SELECT 1 FROM graph_events WHERE entity_id=NEW.id)
      BEGIN UPDATE graph_events SET entity_id=entity_id WHERE entity_id=NEW.id; END;`);
  if(db.query("SELECT 1 FROM sqlite_master WHERE name='graph_migrations'").get())
    db.run("INSERT INTO graph_migrations(name) VALUES('knowledge-editing-v2') ON CONFLICT(name) DO NOTHING");
}
