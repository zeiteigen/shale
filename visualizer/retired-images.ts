import type { Database } from "bun:sqlite";
import type { ClaimFilter, ClaimStatus } from "../sdk/graph/types";

const ACTIVE_STATUSES = new Set<ClaimStatus>(["accepted", "proposed", "disputed"]);

/** Suppress retired connector attachments using full scoped support, independent of map filters. */
export function retiredImageIds(db: Database, filter: ClaimFilter): Set<number> {
  // Historical snapshots must still render their historical relationship endpoints.
  if (filter.knownAt !== undefined || filter.statuses?.some(status => !ACTIVE_STATUSES.has(status)))
    return new Set();

  return new Set(db.query<{ id: number }, []>(`
    SELECT e.id FROM entities e
    WHERE e.type IN ('Image','ImageReference') AND e.stable_id LIKE 'connector:%'
      AND e.canonical_id IS NULL
      AND EXISTS (SELECT 1 FROM graph_claims c
        WHERE (c.subject_id=e.id OR c.object_id=e.id)
          AND c.status NOT IN ('accepted','proposed','disputed'))
      AND NOT EXISTS (SELECT 1 FROM graph_claims c
        WHERE (c.subject_id=e.id OR c.object_id=e.id)
          AND c.status IN ('accepted','proposed','disputed'))
      AND e.id NOT IN (SELECT se.entity_id FROM source_entities se JOIN sources s ON s.id=se.source_id)
      -- Keep merged roots conservatively: their aliases may carry independent live support.
      AND e.id NOT IN (SELECT canonical_id FROM entities WHERE canonical_id IS NOT NULL)
  `).all().map(entity => entity.id));
}
