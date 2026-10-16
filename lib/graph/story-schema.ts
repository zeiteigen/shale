import type { Database } from "bun:sqlite";

const ready = new WeakSet<Database>();

/**
 * Tables for cross-source knowledge: the entity registry index, per-source digests, identity
 * adjudication work, and episodes. Idempotent; callers invoke it lazily before first use.
 *
 * - entity_registry_fts: FTS5 over canonical entity names, aliases, search keys, and descriptions
 *   (rowid = entity id). Like chunks_fts it is not shadowed for access profiles: every query must join
 *   `entities`, whose shadow view hides entities a profile may not see.
 * - graph_source_digests: the model's reading of one source revision (summary, user involvement,
 *   activity, resolved entities), consumed by episode assignment.
 * - graph_digest_signals: the entities that characterise each digested source (resolved entities plus
 *   connector context such as the channel and server); their document frequency weighs episode evidence.
 * - graph_resolution_queue: mention→candidate pairs awaiting a model identity decision.
 * - graph_episodes: metadata for Episode entities; membership is PART_OF_EPISODE claims.
 * - graph_shadow_decisions: deterministic verdicts recorded beside the model's, for promotion by agreement.
 */
export function ensureStorySchema(db: Database) {
  if (ready.has(db)) return;
  const hadProvenance = Boolean(db.query("SELECT 1 FROM sqlite_master WHERE name='graph_episode_provenance'").get());
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS entity_registry_fts USING fts5(text, tokenize='porter unicode61 remove_diacritics 2');
    CREATE TABLE IF NOT EXISTS graph_source_digests (
      source_id TEXT PRIMARY KEY, revision_id INTEGER NOT NULL, digested_at INTEGER NOT NULL,
      summary TEXT NOT NULL DEFAULT '', involvement TEXT NOT NULL DEFAULT 'none'
        CHECK(involvement IN ('none','observer','participant','author')),
      activity TEXT CHECK(activity IS NULL OR json_valid(activity)),
      entity_ids TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(entity_ids)),
      occurred_from INTEGER, occurred_to INTEGER, model TEXT,
      episode_state TEXT NOT NULL DEFAULT 'pending' CHECK(episode_state IN ('pending','assigned','none','review')),
      signals_at INTEGER, episode_checked_at INTEGER
    ) STRICT;
    CREATE INDEX IF NOT EXISTS graph_source_digest_episode ON graph_source_digests(episode_state, occurred_to);
    CREATE TABLE IF NOT EXISTS graph_digest_signals (
      source_id TEXT NOT NULL, entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      PRIMARY KEY(source_id, entity_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS graph_digest_signal_entity ON graph_digest_signals(entity_id);
    CREATE TABLE IF NOT EXISTS graph_resolution_queue (
      mention_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      candidate_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      basis TEXT NOT NULL, created_at INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','same','different','unsure')),
      confidence REAL, decided_at INTEGER, reason TEXT,
      PRIMARY KEY(mention_id, candidate_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS graph_resolution_pending ON graph_resolution_queue(state, created_at);
    CREATE TABLE IF NOT EXISTS graph_episodes (
      entity_id INTEGER PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'other', status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','dormant','closed')),
      summary TEXT NOT NULL DEFAULT '', started_at INTEGER, last_activity_at INTEGER,
      steps TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(steps)),
      updated_at INTEGER NOT NULL, consolidated_at INTEGER
    ) STRICT;
    CREATE INDEX IF NOT EXISTS graph_episode_activity ON graph_episodes(status, last_activity_at);
    -- Narrative inputs survive source removal, detachment, and identity merges.
    CREATE TABLE IF NOT EXISTS graph_episode_provenance (
      entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL,
      PRIMARY KEY(entity_id,source_id)
    ) STRICT;
    -- Deterministic replacements of model decisions, recorded beside the model's verdict until promoted.
    CREATE TABLE IF NOT EXISTS graph_shadow_decisions (
      kind TEXT NOT NULL, subject_key TEXT NOT NULL, method TEXT NOT NULL,
      verdict_json TEXT NOT NULL CHECK(json_valid(verdict_json)),
      llm_verdict_json TEXT CHECK(llm_verdict_json IS NULL OR json_valid(llm_verdict_json)),
      at INTEGER NOT NULL,
      PRIMARY KEY(kind, subject_key, method)
    ) STRICT;
    -- Merged identity groups are walked through canonical_id everywhere; without this SQLite scans entities each time.
    CREATE INDEX IF NOT EXISTS entities_canonical ON entities(canonical_id) WHERE canonical_id IS NOT NULL;
  `);
  // Columns added after a table first shipped: CREATE TABLE IF NOT EXISTS leaves existing tables as they were.
  for (const [table, column, definition] of [
    ['graph_source_digests', 'signals_at', 'INTEGER'],
    ['graph_source_digests', 'episode_checked_at', 'INTEGER'],
    ['graph_episodes', 'steps', "TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(steps))"],
    ['graph_resolution_queue', 'attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ] as const) {
    const columns = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map(row => row.name);
    if (!columns.includes(column)) db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  if (!hadProvenance) db.run(`INSERT OR IGNORE INTO graph_episode_provenance(entity_id,source_id)
    SELECT se.entity_id,se.source_id FROM source_entities se JOIN entities e ON e.id=se.entity_id WHERE e.type='Episode'
    UNION SELECT c.object_id,json_extract(c.qualifiers,'$.sourceId') FROM graph_claims c JOIN entities e ON e.id=c.object_id
      WHERE e.type='Episode' AND c.predicate='PART_OF_EPISODE' AND json_extract(c.qualifiers,'$.sourceId') IS NOT NULL`);
  ready.add(db);
}
