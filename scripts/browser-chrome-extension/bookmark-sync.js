import { allowedTab } from "./capture.js";
import { settings } from "./settings.js";
import { enqueueRecords, nextSequence, hasRecord } from "./outbox.js";
export async function bookmarkSnapshot() {
  const tree = await chrome.bookmarks.getTree(),
    items = [],
    sequence = await nextSequence();
  function walk(nodes, folders = []) {
    for (const node of nodes) {
      if (node.url)
        items.push({
          sequence,
          id: node.id,
          parentId: node.parentId,
          title: node.title || node.url,
          url: node.url,
          dateAdded: Math.round(node.dateAdded || 0),
          folderPath: folders.map((f) => f.title).join(" / "),
          folders,
        });
      else if (node.children)
        walk(
          node.children,
          node.id === "0"
            ? folders
            : [
                ...folders,
                {
                  id: node.id,
                  parentId: node.parentId,
                  title: node.title || "",
                },
              ],
        );
    }
  }
  walk(tree);
  return items;
}
export async function queueBookmark(item, recordId = crypto.randomUUID()) {
  if (await hasRecord(recordId)) return true;
  if (!(await allowedTab({ url: item.url })).allowed) return false;
  const config = await settings();
  await enqueueRecords(
    [
      {
        ...item,
        type: "bookmark_item",
        collectorId: config.collectorId,
        sequence: item.sequence ?? (await nextSequence()),
        recordId,
      },
    ],
    config,
  );
  return true;
}
export async function syncBookmarkChanges() {
  for (const item of await bookmarkSnapshot()) await queueBookmark(item);
}
export async function removedBookmark(id, info) {
  const ids = [];
  function walk(node) {
    if (node.url) ids.push(node.id);
    for (const child of node.children || []) walk(child);
  }
  walk(info.node);
  if (!ids.length) ids.push(id);
  const config = await settings();
  for (let i = 0; i < ids.length; i += 100)
    await enqueueRecords(
      [
        {
          type: "catalog_delete",
          catalog: "bookmark",
          recordId: crypto.randomUUID(),
          sequence: await nextSequence(),
          ids: ids.slice(i, i + 100),
        },
      ],
      config,
    );
}
