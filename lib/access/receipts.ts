import type { VisibleSet } from "./visibility";

type Visible = (set: VisibleSet, id: string | number) => boolean;
type RecordValue = Record<string, unknown>;

/** Receipt inspections have the same graph record shapes as readers, including nested batches. */
export function redactReceipt<T>(receipt: T, visible: Visible): T {
  const source = (id: unknown) => visible("sources", String(id)) || visible("archives", String(id));
  const claim = (id: unknown) => visible("claims", String(id));
  const entity = (id: unknown) => visible("entities", Number(id));
  const recordVisible = (kind: unknown, id: unknown) => {
    switch (kind) {
      case "source": return source(id);
      case "entity": case "event": return entity(id);
      case "claim": return claim(id);
      case "chunk": return visible("chunks", Number(id));
      case "evidence": return visible("evidence", String(id));
      default: return true;
    }
  };
  function clean(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(clean).filter(item => item !== undefined);
    if (!value || typeof value !== "object") return value;
    const row = value as RecordValue;
    if ("predicate" in row && "subject" in row && "id" in row && !claim(row.id)) return undefined;
    if ("stableId" in row && "canonicalId" in row && "id" in row && !entity(row.id)) return undefined;
    if ("revisionId" in row && "claimId" in row && "id" in row && !visible("evidence", String(row.id))) return undefined;
    if ("source_id" in row && "target_id" in row && (!claim(row.source_id) || !claim(row.target_id))) return undefined;
    if ("entity_id" in row && "canonical_id" in row && (!entity(row.entity_id) || !entity(row.canonical_id))) return undefined;
    if ("claim_id" in row && !claim(row.claim_id)) return undefined;
    if ("entity" in row && typeof row.entity === "number" && (!entity(row.entity) || (row.claimId !== undefined && !claim(row.claimId)))) return undefined;
    const copy: RecordValue = {};
    for (const [key, field] of Object.entries(row)) {
      if (key === "before" || key === "after") continue;
      // Caller-supplied args and visible claim values are data, not receipt record envelopes.
      if (key === "args" || key === "value" || key === "qualifiers") { copy[key] = field; continue; }
      if ((key === "dependents" || key === "dependencies" || key === "requiresReview") && Array.isArray(field)) {
        copy[key] = field.filter(id => claim(id)); continue;
      }
      if (key === "affectedRecords" && Array.isArray(field)) {
        copy[key] = field.filter((r: RecordValue) => recordVisible(r.kind, r.record_id)); continue;
      }
      if (key === "entityRefs" && field && typeof field === "object") {
        copy[key] = Object.fromEntries(Object.entries(field).filter(([, id]) => entity(id))); continue;
      }
      if (key === "canonicalId" && field !== null && !entity(field)) { copy[key] = null; continue; }
      if (key === "replacementId" && field !== undefined && field !== null && !visible("evidence", String(field))) continue;
      const cleaned = clean(field);
      if (cleaned !== undefined) copy[key] = cleaned;
    }
    if (typeof copy.affectedClaimCount === "number" && Array.isArray(copy.affectedRecords))
      copy.affectedClaimCount = copy.affectedRecords.filter((r: RecordValue) => r.kind === "claim").length;
    return copy;
  }
  return clean(receipt) as T;
}
