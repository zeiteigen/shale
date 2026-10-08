/** Source titles are display labels; graph identity follows the persistent source ID. */
export const sourceEntityName = (sourceId: string): string => `source:${sourceId}`;
export const sourceIdFromEntity = (name: string): string | undefined =>
  name.startsWith("source:") ? name.slice("source:".length) : undefined;

/** Browser history/bookmarks/versions share their rich page's URI identity. */
export function graphIdentityFromSourceUri(uri: string): string {
  if (!uri) return "";

  if (uri.startsWith("browser-history:")) {
    const rest = uri.slice("browser-history:".length);
    if (rest.startsWith("//")) {
      const parts = rest.slice(2).split("/");
      if (parts.length > 1) {
        try {
          return decodeURIComponent(parts.slice(1).join("/"));
        } catch {
          return parts.slice(1).join("/");
        }
      }
    }
    return rest;
  }

  if (uri.startsWith("browser-content-version:")) {
    const rest = uri.slice("browser-content-version:".length);
    const cleaned = rest.startsWith("//") ? rest.slice(2) : rest;
    const lastSlash = cleaned.lastIndexOf("/");
    const candidate = lastSlash > 0 ? cleaned.slice(0, lastSlash) : cleaned;
    try {
      return decodeURIComponent(candidate);
    } catch {
      return candidate;
    }
  }

  if (uri.startsWith("browser-public:")) {
    const rest = uri.slice("browser-public:".length);
    const cleaned = rest.startsWith("//") ? rest.slice(2) : rest;
    try {
      return decodeURIComponent(cleaned);
    } catch {
      return cleaned;
    }
  }

  if (uri.startsWith("browser-bookmark:")) {
    const urlStart = uri.search(/:https?:\/\//);
    if (urlStart >= 0) return uri.slice(urlStart + 1);
  }

  return uri;
}
