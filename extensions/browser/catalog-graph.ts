import { SourceGraph, type ShaleSDK } from "@shale/sdk";

export interface CatalogRecord {
  title: string;
  sourceId: string;
  sourceUri: string;
  pageEntity: string;
  filter: { domain: string; cleanUrl: string };
  visitTime?: number;
  visitCount?: number;
  typedCount?: number;
  folder?: string;
  dateAdded?: number;
  original?: {
    collectorId?: string;
    parentId?: string;
    folders?: Array<{ id: string; title: string; parentId?: string }>;
  };
}

/** History counts are aggregates; bookmark records are distinct occurrences. */
export function commitCatalogGraph(
  sdk: ShaleSDK,
  record: CatalogRecord,
  namespace: string,
) {
  const graph = new SourceGraph(
    sdk.database,
    sdk.graph,
    record.sourceId,
    namespace,
    record.visitTime ?? record.dateAdded,
  );
  const observed = { evidence: graph.evidence(0) };
  const page = graph.entity(
    record.pageEntity,
    record.title,
    "WebPage",
    record.pageEntity,
  );
  graph.link(
    page,
    "BELONGS_TO_DOMAIN",
    graph.entity(
      record.filter.domain,
      record.filter.domain,
      "Domain",
      record.filter.domain,
    ),
    observed,
  );
  // History is an aggregate about the page itself; only bookmarks are distinct records.
  if (record.folder === undefined) {
    graph.claim(page, "SOURCE_URI", { value: record.sourceUri }, observed);
    graph.claim(page, "LAST_VISITED_AT", { value: record.visitTime! }, observed);
    if (record.visitCount !== undefined)
      graph.claim(page, "VISIT_COUNT", { value: record.visitCount }, observed);
    if (record.typedCount !== undefined)
      graph.claim(page, "TYPED_COUNT", { value: record.typedCount }, observed);
    return graph;
  }
  const entity = graph.entity(record.sourceUri, record.title, "Bookmark");
  graph.claim(entity, "SOURCE_URI", { value: record.sourceUri }, observed);
  graph.link(entity, "REFERS_TO", page, observed);
  const folderKey =
    record.original?.collectorId && record.original.parentId
      ? `browser-folder://${record.original.collectorId}/${record.original.parentId}`
      : record.folder;
  const folder = graph.entity(
    folderKey,
    record.folder,
    "BookmarkFolder",
    folderKey,
  );
  graph.link(entity, "IN_FOLDER", folder, observed);
  graph.link(page, "BOOKMARKED_IN", folder, {
    ...observed,
    qualifiers: { bookmark: record.sourceUri },
  });
  graph.claim(entity, "ADDED_AT", { value: record.dateAdded! }, observed);
  graph.event("bookmark-added", {
    name: `Bookmarked ${record.title}`,
    kind: "bookmark_added",
    occurredFrom: record.dateAdded,
    evidence: observed.evidence,
    participants: [
      { entity, role: "bookmark" },
      { entity: page, role: "page" },
      { entity: folder, role: "folder" },
    ],
  });
  if (record.original?.collectorId && record.original.folders) {
    const folders = record.original.folders;
    for (let i = 1; i < folders.length; i++) {
      const child = folders[i]!,
        parent = folders[i - 1]!;
      graph.link(
        graph.entity(
          `browser-folder://${record.original.collectorId}/${child.id}`,
          child.title,
          "BookmarkFolder",
        ),
        "PART_OF",
        graph.entity(
          `browser-folder://${record.original.collectorId}/${parent.id}`,
          parent.title,
          "BookmarkFolder",
        ),
        observed,
      );
    }
    return graph;
  }
  const parts = record.folder
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  for (let i = 1; i < parts.length; i++) {
    const child = parts.slice(0, i + 1).join("/"),
      parent = parts.slice(0, i).join("/");
    graph.link(
      graph.entity(child, child, "BookmarkFolder", child),
      "PART_OF",
      graph.entity(parent, parent, "BookmarkFolder", parent),
      observed,
    );
  }
  return graph;
}
