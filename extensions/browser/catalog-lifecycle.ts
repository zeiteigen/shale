import type { ShaleSDK } from "@shale/sdk";
import type { CatalogDeletePayload } from "../../lib/browser-contract";
import { normalizeUrl } from "./filter";
/** Catalog removal changes current membership while retaining historical evidence by default. */
export function applyCatalogDeletion(
  sdk: ShaleSDK,
  payload: CatalogDeletePayload,
) {
  const collector = payload.collectorId ?? "legacy";
  sdk.database.transaction(() => {
    const rows = sdk.database
      .query<
        { external_id: string; source_id: string; payload: string },
        [string, string, string]
      >(
        "SELECT external_id,source_id,payload FROM browser_catalog WHERE extension_id=? AND collector_id=? AND kind=?",
      )
      .all(sdk.extensionId, collector, payload.catalog);
    const urls = new Set(
      (payload.urls ?? []).map((url) => normalizeUrl(url).cleanUrl),
    );
    for (const row of rows) {
      const old = JSON.parse(row.payload);
      if (
        payload.sequence !== undefined &&
        old.sequence !== undefined &&
        payload.sequence < old.sequence
      )
        continue;
      if (
        payload.all ||
        payload.ids?.includes(row.external_id) ||
        urls.has(normalizeUrl(old.url).cleanUrl)
      ) {
        sdk.database
          .query(
            "UPDATE browser_catalog SET active=0,payload=? WHERE extension_id=? AND collector_id=? AND kind=? AND external_id=?",
          )
          .run(
            JSON.stringify({
              ...old,
              sequence: payload.sequence ?? old.sequence,
            }),
            sdk.extensionId,
            collector,
            payload.catalog,
            row.external_id,
          );
        // Retain the source revision but retract claims of current folder membership.
        sdk.database
          .query(
            `UPDATE graph_claims SET status='retracted' WHERE predicate IN ('IN_FOLDER','BOOKMARKED_IN','PART_OF')
          AND status IN ('accepted','proposed') AND id IN (SELECT e.claim_id FROM graph_evidence e
            JOIN graph_source_revisions r ON r.id=e.revision_id WHERE r.source_id=?)`,
          )
          .run(row.source_id);
        if (sdk.settings.get<boolean>("retainRemovedCatalogEvidence") === false)
          sdk.database
            .query("DELETE FROM sources WHERE id=?")
            .run(row.source_id);
      }
    }
  })();
}
export function recordCatalog(
  sdk: ShaleSDK,
  kind: string,
  item: any,
  sourceId: string,
) {
  const collector = item.collectorId ?? "legacy",
    id = item.id || normalizeUrl(item.url).cleanUrl;
  sdk.database
    .query(
      `INSERT INTO browser_catalog VALUES(?,?,?,?,?,1,?) ON CONFLICT(extension_id,collector_id,kind,external_id)
    DO UPDATE SET source_id=excluded.source_id,active=1,payload=excluded.payload`,
    )
    .run(sdk.extensionId, collector, kind, id, sourceId, JSON.stringify(item));
}

export function isCatalogStale(sdk: ShaleSDK, kind: string, item: any) {
  const row = sdk.database
    .query<{ payload: string }, [string, string, string, string]>(
      "SELECT payload FROM browser_catalog WHERE extension_id=? AND collector_id=? AND kind=? AND external_id=?",
    )
    .get(
      sdk.extensionId,
      item.collectorId ?? "legacy",
      kind,
      item.id || normalizeUrl(item.url).cleanUrl,
    );
  if (!row) return false;
  const old = JSON.parse(row.payload);
  return kind === "history"
    ? (old.visitTime ?? 0) > (item.visitTime ?? 0)
    : old.sequence !== undefined &&
        item.sequence !== undefined &&
        old.sequence > item.sequence;
}
