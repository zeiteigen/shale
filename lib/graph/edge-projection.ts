import type { Database } from "bun:sqlite";

/**
 * `edges` is a projection of live object claims. Claims are staled in bulk by SQL triggers
 * (source replacement/deletion, evidence withdrawal), so the projection is kept in SQL too:
 * when a claim stops being live, its edge goes unless another live claim still justifies it.
 */
export function ensureEdgeProjection(db: Database) {
  db.run(`CREATE TRIGGER IF NOT EXISTS graph_edge_projection AFTER UPDATE OF status ON graph_claims
    WHEN NEW.object_id IS NOT NULL AND OLD.status IN ('accepted','proposed','disputed')
      AND NEW.status NOT IN ('accepted','proposed','disputed')
    BEGIN
      DELETE FROM edges WHERE source_entity_id=NEW.subject_id AND target_entity_id=NEW.object_id AND relation=NEW.predicate
        AND NOT EXISTS(SELECT 1 FROM graph_claims c WHERE c.subject_id=NEW.subject_id AND c.object_id=NEW.object_id
          AND c.predicate=NEW.predicate AND c.polarity=1 AND c.status IN ('accepted','proposed','disputed'));
    END;`);
}
