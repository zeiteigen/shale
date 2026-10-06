import { ensureRevisionUpsertSafety } from './revision-upsert-safety';
import type { Database } from "bun:sqlite";
import { installRevisionTracking } from "./source-revisions";

/** Additive migration: legacy node IDs and edge consumers remain valid. */
export function ensureGraphSchema(db: Database) {
  if (db.query("SELECT 1 FROM sqlite_master WHERE name='graph_migrations'").get() &&
      db.query("SELECT 1 FROM graph_migrations WHERE name='knowledge-schema-v2'").get()) {ensureRevisionUpsertSafety(db);return;}
  db.transaction(() => {
    db.run(`CREATE TABLE IF NOT EXISTS entities (id INTEGER PRIMARY KEY,namespace TEXT NOT NULL,name TEXT NOT NULL,type TEXT NOT NULL,UNIQUE(namespace,name)) STRICT;
      CREATE TABLE IF NOT EXISTS edges (source_entity_id INTEGER NOT NULL REFERENCES entities(id),target_entity_id INTEGER NOT NULL REFERENCES entities(id),
        relation TEXT NOT NULL,weight REAL NOT NULL DEFAULT 1,metadata TEXT,PRIMARY KEY(source_entity_id,target_entity_id,relation)) STRICT;`);
    const columns = new Set(db.query<{ name: string }, []>("PRAGMA table_info(entities)").all().map(c => c.name));
    for (const [name, type] of [["stable_id", "TEXT"], ["display_name", "TEXT"], ["canonical_id", "INTEGER REFERENCES entities(id)"]]) {
      if (!columns.has(name)) db.run(`ALTER TABLE entities ADD COLUMN ${name} ${type}`);
    }
    db.run("UPDATE entities SET stable_id = lower(hex(randomblob(16))) WHERE stable_id IS NULL");
    db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS entities_stable_id ON entities(stable_id);
      CREATE TRIGGER IF NOT EXISTS entities_identity AFTER INSERT ON entities WHEN NEW.stable_id IS NULL BEGIN
        UPDATE entities SET stable_id = lower(hex(randomblob(16))) WHERE id = NEW.id;
      END;
      CREATE TABLE IF NOT EXISTS graph_relations (
        name TEXT PRIMARY KEY, definition TEXT NOT NULL CHECK(json_valid(definition))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS graph_aliases (
        entity_id INTEGER NOT NULL REFERENCES entities(id), alias TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(entity_id, alias, scope)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS graph_alias_lookup ON graph_aliases(alias, scope);
      CREATE TABLE IF NOT EXISTS graph_identity_changes (
        id TEXT PRIMARY KEY, entity_id INTEGER NOT NULL REFERENCES entities(id),
        canonical_id INTEGER NOT NULL REFERENCES entities(id), reason TEXT NOT NULL,
        created_at INTEGER NOT NULL, undone_at INTEGER
      ) STRICT;
      CREATE TABLE IF NOT EXISTS graph_claims (
        id TEXT PRIMARY KEY, namespace TEXT NOT NULL,
        subject_id INTEGER NOT NULL REFERENCES entities(id), predicate TEXT NOT NULL,
        object_id INTEGER REFERENCES entities(id), value_json TEXT CHECK(value_json IS NULL OR json_valid(value_json)),
        datatype TEXT, unit TEXT, language TEXT,
        polarity INTEGER NOT NULL DEFAULT 1 CHECK(polarity IN (-1,1)),
        context TEXT NOT NULL DEFAULT '', qualifiers TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(qualifiers)),
        valid_from INTEGER, valid_to INTEGER, observed_at INTEGER NOT NULL, recorded_at INTEGER NOT NULL,
        confidence REAL CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
        strength REAL NOT NULL DEFAULT 1, method TEXT NOT NULL, model TEXT, extraction_run TEXT,
        status TEXT NOT NULL CHECK(status IN ('proposed','accepted','disputed','rejected','superseded','retracted','stale')),
        CHECK((object_id IS NOT NULL) != (value_json IS NOT NULL)),
        CHECK(valid_from IS NULL OR valid_to IS NULL OR valid_from < valid_to)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS graph_claim_subject ON graph_claims(subject_id,predicate,status);
      CREATE INDEX IF NOT EXISTS graph_claim_object ON graph_claims(object_id,predicate,status);
      CREATE INDEX IF NOT EXISTS graph_claim_scope ON graph_claims(namespace,context,status,valid_from,valid_to);
      CREATE TABLE IF NOT EXISTS graph_dependencies (
        claim_id TEXT NOT NULL REFERENCES graph_claims(id), depends_on TEXT NOT NULL REFERENCES graph_claims(id),
        PRIMARY KEY(claim_id,depends_on), CHECK(claim_id != depends_on)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS graph_dependency_parent ON graph_dependencies(depends_on);
      CREATE TABLE IF NOT EXISTS graph_claim_links (
        source_id TEXT NOT NULL REFERENCES graph_claims(id), target_id TEXT NOT NULL REFERENCES graph_claims(id),
        relation TEXT NOT NULL CHECK(relation IN ('supports','contradicts','supersedes')),
        PRIMARY KEY(source_id,target_id,relation), CHECK(source_id != target_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS graph_reviews (
        id INTEGER PRIMARY KEY, claim_id TEXT NOT NULL REFERENCES graph_claims(id),
        previous_status TEXT NOT NULL, status TEXT NOT NULL, actor TEXT NOT NULL, reason TEXT NOT NULL, reviewed_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS graph_status_history (
        id INTEGER PRIMARY KEY, claim_id TEXT NOT NULL REFERENCES graph_claims(id), status TEXT NOT NULL, changed_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS graph_status_claim ON graph_status_history(claim_id,changed_at);
      CREATE TRIGGER IF NOT EXISTS graph_status_insert AFTER INSERT ON graph_claims BEGIN
        INSERT INTO graph_status_history(claim_id,status,changed_at) VALUES(NEW.id,NEW.status,NEW.recorded_at);
      END;
      CREATE TRIGGER IF NOT EXISTS graph_status_update AFTER UPDATE OF status ON graph_claims WHEN NEW.status!=OLD.status BEGIN
        INSERT INTO graph_status_history(claim_id,status,changed_at) VALUES(NEW.id,NEW.status,CAST(unixepoch('subsec')*1000 AS INTEGER));
      END;
      CREATE TRIGGER IF NOT EXISTS graph_invalidate_dependents AFTER UPDATE OF status ON graph_claims
      WHEN NEW.status IN ('rejected','superseded','retracted','stale','disputed') AND OLD.status != NEW.status BEGIN
        UPDATE graph_claims SET status = 'stale' WHERE status IN ('accepted','proposed') AND id IN (
          WITH RECURSIVE downstream(id) AS (
            SELECT claim_id FROM graph_dependencies WHERE depends_on = NEW.id
            UNION SELECT d.claim_id FROM graph_dependencies d JOIN downstream p ON d.depends_on = p.id
          ) SELECT id FROM downstream
        );
      END;
      CREATE TABLE IF NOT EXISTS graph_events (
        entity_id INTEGER PRIMARY KEY REFERENCES entities(id), kind TEXT NOT NULL,
        occurred_from INTEGER, occurred_to INTEGER, context TEXT NOT NULL DEFAULT '',
        claim_id TEXT REFERENCES graph_claims(id),
        CHECK(occurred_from IS NULL OR occurred_to IS NULL OR occurred_from <= occurred_to)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS graph_participants (
        event_id INTEGER NOT NULL REFERENCES graph_events(entity_id), entity_id INTEGER NOT NULL REFERENCES entities(id),
        role TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, claim_id TEXT NOT NULL REFERENCES graph_claims(id),
        PRIMARY KEY(event_id,role,position,entity_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS graph_migrations (name TEXT PRIMARY KEY) STRICT;
    `);
    if (!db.query<{name:string}, []>('PRAGMA table_info(graph_events)').all().some(c=>c.name==='claim_id'))
      db.run('ALTER TABLE graph_events ADD COLUMN claim_id TEXT REFERENCES graph_claims(id)');
    db.run(`INSERT INTO graph_claims(id,namespace,subject_id,predicate,value_json,observed_at,recorded_at,method,status)
      SELECT 'legacy-event:'||g.entity_id,e.namespace,g.entity_id,'EVENT_KIND',json_quote(g.kind),0,0,'legacy','proposed'
      FROM graph_events g JOIN entities e ON e.id=g.entity_id WHERE g.claim_id IS NULL;
      UPDATE graph_events SET claim_id='legacy-event:'||entity_id WHERE claim_id IS NULL;`);
    installRevisionTracking(db);
    ensureRevisionUpsertSafety(db);
    // Import existing topology once; do not invent confidence or evidence for old edges.
    if (!db.query("SELECT 1 FROM graph_migrations WHERE name = 'legacy-edges-v1'").get()) {
      const hasMetadata=db.query<{name:string}, []>('PRAGMA table_info(edges)').all().some(c=>c.name==='metadata');
      const metadata=hasMetadata ? `CASE WHEN e.metadata IS NULL THEN '{}' WHEN json_valid(e.metadata)
        THEN CASE WHEN json_type(e.metadata)='object' THEN e.metadata ELSE json_object('legacyMetadata',e.metadata) END
        ELSE json_object('legacyMetadata',e.metadata) END` : "'{}'";
      db.run(`INSERT INTO graph_claims
        (id,namespace,subject_id,predicate,object_id,qualifiers,observed_at,recorded_at,strength,method,status)
        SELECT 'legacy:' || e.source_entity_id || ':' || e.target_entity_id || ':' || e.relation,
          n.namespace,e.source_entity_id,e.relation,e.target_entity_id,${metadata},0,0,e.weight,'legacy','accepted'
        FROM edges e JOIN entities n ON n.id=e.source_entity_id`);
      db.run("INSERT INTO graph_migrations VALUES ('legacy-edges-v1')");
    }
    db.run("INSERT INTO graph_migrations VALUES ('knowledge-schema-v2')");
  })();
}
