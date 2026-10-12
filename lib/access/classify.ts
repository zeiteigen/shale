import type { Database } from "bun:sqlite";
import { classifyClaim, classifyEntity, classifySource, type Classification } from "./heuristics";
import { setLabel } from "./schema";

const SOURCE_TEXT_LIMIT = 200_000;

export function entityContentHash(name: string, type: string) {
  return `${name}\u001f${type}`;
}

export interface ClassifyResult {
  sources: number;
  entities: number;
  claims: number;
  /** True when the time budget ran out before every pending record was classified. */
  pending: boolean;
}

function store(db: Database, kind: "source" | "entity" | "claim", id: string, result: Classification, contentHash: string) {
  setLabel(db, kind, id, "heuristic", result.tier, { hard: result.hard, reason: result.reason, contentHash });
}

/**
 * Give every new or changed record a heuristic tier. Unclassified records are treated as secret
 * by restricted profiles, so this runs before visibility is computed and in the background.
 */
export function classifyPending(db: Database, options: { batch?: number; budgetMs?: number; ids?: { sources?: string[]; entities?: number[]; claims?: string[] } } = {}): ClassifyResult {
  const batch = options.batch ?? 200;
  const deadline = Date.now() + (options.budgetMs ?? 2_000);
  const result: ClassifyResult = { sources: 0, entities: 0, claims: 0, pending: false };
  const only = options.ids;
  const filter = (column: string, values: unknown[] | undefined) =>
    values ? (values.length ? ` AND ${column} IN (${values.map(() => "?").join(",")})` : " AND 0") : "";

  const sourceText = db.query<{ text_content: string }, [string]>("SELECT text_content FROM chunks WHERE source_id=? ORDER BY chunk_index");
  for (;;) {
    const rows = db.query<{ id: string; title: string; uri: string; origin: string; type: string; hash: string }, (string | number)[]>(
      `SELECT s.id,s.title,s.uri,s.origin,s.type,s.hash FROM sources s
       LEFT JOIN graph_access_labels l ON l.kind='source' AND l.record_id=s.id AND l.origin='heuristic'
       WHERE (l.record_id IS NULL OR l.content_hash<>s.hash)${filter("s.id", only ? only.sources ?? [] : undefined)} LIMIT ?`,
    ).all(...(only ? only.sources ?? [] : []), batch);
    if (!rows.length) break;
    db.transaction(() => {
      for (const source of rows) {
        let text = "";
        for (const chunk of sourceText.iterate(source.id)) {
          text += `${chunk.text_content}\n`;
          if (text.length >= SOURCE_TEXT_LIMIT) break;
        }
        store(db, "source", source.id, classifySource({ ...source, text }), source.hash);
      }
    })();
    result.sources += rows.length;
    if (only || Date.now() > deadline) { result.pending = !only && rows.length === batch; break; }
  }

  for (;;) {
    if (!only && Date.now() > deadline) { result.pending = true; break; }
    const rows = db.query<{ id: number; name: string; type: string }, (number)[]>(
      `SELECT e.id,e.name,e.type FROM entities e
       LEFT JOIN graph_access_labels l ON l.kind='entity' AND l.record_id=CAST(e.id AS TEXT) AND l.origin='heuristic'
       WHERE (l.record_id IS NULL OR l.content_hash<>e.name||char(31)||e.type)${filter("e.id", only ? only.entities ?? [] : undefined)} LIMIT ?`,
    ).all(...(only ? only.entities ?? [] : []), batch);
    if (!rows.length) break;
    db.transaction(() => {
      for (const entity of rows) store(db, "entity", String(entity.id), classifyEntity(entity), entityContentHash(entity.name, entity.type));
    })();
    result.entities += rows.length;
    if (only) break;
  }

  for (;;) {
    if (!only && Date.now() > deadline) { result.pending = true; break; }
    const rows = db.query<{ id: string; predicate: string; value_json: string | null; qualifiers: string; context: string }, (string | number)[]>(
      `SELECT c.id,c.predicate,c.value_json,c.qualifiers,c.context FROM graph_claims c
       WHERE NOT EXISTS(SELECT 1 FROM graph_access_labels l WHERE l.kind='claim' AND l.record_id=c.id AND l.origin='heuristic')
       ${filter("c.id", only ? only.claims ?? [] : undefined)} LIMIT ?`,
    ).all(...(only ? only.claims ?? [] : []), batch);
    if (!rows.length) break;
    db.transaction(() => {
      for (const claim of rows) store(db, "claim", claim.id, classifyClaim({ ...claim, value: claim.value_json }), "");
    })();
    result.claims += rows.length;
    if (only) break;
  }
  return result;
}
