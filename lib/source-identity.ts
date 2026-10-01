/** Source titles are display labels; graph identity follows the persistent source ID. */
export const sourceEntityName = (sourceId: string): string => `source:${sourceId}`;
export const sourceIdFromEntity = (name: string): string | undefined =>
  name.startsWith("source:") ? name.slice("source:".length) : undefined;

/** Browser history/bookmarks share their rich page's URI identity. */
export function graphIdentityFromSourceUri(uri: string): string {
  if (uri.startsWith("browser-history:")) return uri.slice("browser-history:".length);
  if (uri.startsWith("browser-bookmark:")) {
    const urlStart = uri.search(/:https?:\/\//);
    if (urlStart >= 0) return uri.slice(urlStart + 1);
  }
  return uri;
}
