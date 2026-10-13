import type { Database } from "bun:sqlite";

export function ensureRetirementSchema(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS graph_entity_retirements (
    entity_id INTEGER PRIMARY KEY REFERENCES entities(id) ON DELETE CASCADE,
    reason TEXT NOT NULL, retired_at INTEGER NOT NULL
  ) STRICT`);
}

/** Historical identities survive cleanup; current discovery omits unsupported connector nodes. */
export function retireUnsupportedEntities(db: Database, ids: number[], reason: string) {
  const retire = db.query(`INSERT INTO graph_entity_retirements(entity_id,reason,retired_at)
    SELECT e.id,?,? FROM entities e WHERE e.id=? AND e.stable_id LIKE 'connector:%'
      AND e.canonical_id IS NULL
      AND NOT EXISTS(SELECT 1 FROM entities m WHERE m.canonical_id=e.id)
      AND NOT EXISTS(SELECT 1 FROM graph_identity_changes i WHERE i.entity_id=e.id OR i.canonical_id=e.id)
      AND NOT EXISTS(SELECT 1 FROM source_entities se JOIN sources s ON s.id=se.source_id WHERE se.entity_id=e.id)
      AND NOT EXISTS(SELECT 1 FROM chunk_entities ce JOIN chunks c ON c.id=ce.chunk_id WHERE ce.entity_id=e.id)
      AND NOT EXISTS(SELECT 1 FROM graph_claims c WHERE (c.subject_id=e.id OR c.object_id=e.id)
        AND (c.status IN ('accepted','proposed','disputed') OR c.method='manual'))
      AND NOT EXISTS(SELECT 1 FROM graph_changes ch,json_tree(ch.operations) j
        WHERE ch.actor NOT LIKE 'extension:discord%' AND j.key='id' AND CAST(j.value AS TEXT)=CAST(e.id AS TEXT))
    ON CONFLICT(entity_id) DO UPDATE SET reason=excluded.reason,retired_at=excluded.retired_at`);
  for (const id of ids) retire.run(reason, Date.now(), id);
}

export function retiredEntityIds(db: Database): Set<number> {
  return new Set(db.query<{entity_id:number},[]>("SELECT entity_id FROM graph_entity_retirements").all().map(row => row.entity_id));
}
