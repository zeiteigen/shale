import type { Database } from "bun:sqlite";
import { graphIdentityFromSourceUri } from "../source-identity";

/** Return the excluded source ID (or the current ID owning this URI), if any. */
export function excludedSourceId(
  db: Database,
  id: string | undefined,
  uri: string,
): string | undefined {
  const canonical = db
    .query<{ id: string }, [string]>("SELECT id FROM sources WHERE uri=?")
    .get(uri)?.id;
  const identities = [...new Set([
    ...(id ? [id, `id:${id}`] : []),
    ...(canonical ? [canonical, `id:${canonical}`] : []),
    uri,
    graphIdentityFromSourceUri(uri),
  ].filter(Boolean))];
  if (!identities.length) return undefined;
  const exclusion = db.query<{ source_id: string }, string[]>(
    `SELECT source_id FROM graph_source_exclusions WHERE identity IN (${identities.map(() => "?").join(",")}) LIMIT 1`,
  ).get(...identities);
  return exclusion?.source_id;
}

export function isSourceExcluded(
  db: Database,
  id: string | undefined,
  uri: string,
): boolean {
  return excludedSourceId(db, id, uri) !== undefined;
}
