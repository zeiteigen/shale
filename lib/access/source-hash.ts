export interface SourceContent {
  hash: string;
  title: string;
  uri: string;
  origin: string;
  type: string;
}

/** Automatic verdicts judge source metadata as well as its retained text. */
export function sourceContentHash(source: SourceContent): string {
  return JSON.stringify([source.hash, source.title, source.uri, source.origin, source.type]);
}

export function sourceContentHashSql(columns: SourceContent): string {
  return `json_array(${columns.hash},${columns.title},${columns.uri},${columns.origin},${columns.type})`;
}

export const LIVE_SOURCE_CONTENT_HASH_SQL = sourceContentHashSql({
  hash: "s.hash", title: "s.title", uri: "s.uri", origin: "s.origin", type: "s.type",
});
