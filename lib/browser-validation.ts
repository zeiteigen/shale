import {
  BROWSER_PROTOCOL_VERSION,
  MAX_BROWSER_BYTES,
  MAX_BROWSER_RECORDS,
  type BrowserIngestPayload,
} from "./browser-contract";

export class BrowserProtocolError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
const object = (v: unknown): v is Record<string, any> =>
  !!v && typeof v === "object" && !Array.isArray(v);
function fail(path: string): never {
  throw new BrowserProtocolError(`Invalid browser field: ${path}`);
}
function string(v: unknown, path: string, max = 2048, required = false) {
  if (v === undefined && !required) return;
  if (typeof v !== "string" || v.length > max || (required && !v.trim()))
    fail(path);
}
function number(v: unknown, path: string, max = Number.MAX_SAFE_INTEGER) {
  if (
    v !== undefined &&
    (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > max)
  )
    fail(path);
}
function url(v: unknown, path: string) {
  string(v, path, 8192, true);
  try {
    const parsed = new URL(v as string);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    )
      fail(path);
  } catch {
    fail(path);
  }
}
function array(
  v: unknown,
  path: string,
  max: number,
  check: (item: any, path: string) => void,
) {
  if (!Array.isArray(v) || v.length > max) fail(path);
  v.forEach((item, i) => check(item, `${path}[${i}]`));
}
function identity(v: Record<string, any>, path: string) {
  for (const k of [
    "recordId",
    "eventId",
    "collectorId",
    "documentId",
    "navigationEventId",
    "browserInstanceId",
    "sessionId",
  ])
    string(v[k], `${path}.${k}`, 200);
  for (const k of [
    "sequence",
    "visitedAt",
    "capturedAt",
    "visitTime",
    "dateAdded",
    "tabId",
    "windowId",
    "openerTabId",
    "syncedAt",
    "startTime",
    "endTime",
    "visitCount",
    "typedCount",
    "durationMs",
  ])
    number(v[k], `${path}.${k}`);
  for (const k of ["incognito", "recordInSession", "attended"])
    if (v[k] !== undefined && typeof v[k] !== "boolean") fail(`${path}.${k}`);
  if (
    v.captureOrigin !== undefined &&
    !["live-dom", "tab-metadata", "public-fetch"].includes(v.captureOrigin)
  )
    fail(`${path}.captureOrigin`);
  string(v.goal, `${path}.goal`, 300);
  string(v.tabGroup, `${path}.tabGroup`, 300);
  string(v.transitionType, `${path}.transitionType`, 100);
}
function record(v: unknown, path: string, versioned = false): void {
  if (!object(v)) fail(path);
  identity(v, path);
  if (versioned) string(v.recordId, `${path}.recordId`, 200, true);
  switch (v.type) {
    case "page_visit":
    case "active_page":
      url(v.url, `${path}.url`);
      string(v.title, `${path}.title`, 2000);
      string(v.textContent, `${path}.textContent`, 100000, true);
      string(v.html, `${path}.html`, 200000);
      string(v.excerpt, `${path}.excerpt`, 2000);
      string(v.author, `${path}.author`, 500);
      string(v.favIconUrl, `${path}.favIconUrl`, 8192);
      if (v.canonicalUrl !== undefined)
        url(v.canonicalUrl, `${path}.canonicalUrl`);
      if (v.links !== undefined)
        array(v.links, `${path}.links`, 100, (x, p) => {
          if (!object(x)) fail(p);
          url(x.url, `${p}.url`);
          string(x.text, `${p}.text`, 500);
          string(x.rel, `${p}.rel`, 200);
        });
      if (v.images !== undefined)
        array(v.images, `${path}.images`, 25, (x, p) => {
          if (!object(x)) fail(p);
          url(x.url, `${p}.url`);
          string(x.alt, `${p}.alt`, 1000);
          number(x.width, `${p}.width`, 100000);
          number(x.height, `${p}.height`, 100000);
        });
      if (v.blocks !== undefined)
        array(v.blocks, `${path}.blocks`, 500, (x, p) => {
          if (
            !object(x) ||
            ![
              "heading",
              "paragraph",
              "list",
              "table",
              "code",
              "quote",
              "caption",
            ].includes(x.kind)
          )
            fail(p);
          string(x.text, `${p}.text`, 20000, true);
          string(x.locator, `${p}.locator`, 500, true);
          array(x.headingPath, `${p}.headingPath`, 10, (t, q) =>
            string(t, q, 500),
          );
          number(x.level, `${p}.level`, 6);
        });
      if (v.extraction !== undefined) {
        const x = v.extraction;
        if (
          !object(x) ||
          !["full", "partial", "metadata"].includes(x.quality) ||
          typeof x.truncated !== "boolean"
        )
          fail(`${path}.extraction`);
        string(x.method, `${path}.extraction.method`, 100, true);
        string(x.version, `${path}.extraction.version`, 100, true);
        number(x.originalChars, `${path}.extraction.originalChars`);
        array(x.reasons, `${path}.extraction.reasons`, 20, (t, q) =>
          string(t, q, 300),
        );
      }
      break;
    case "activity_event":
      url(v.url, `${path}.url`);
      string(v.title, `${path}.title`, 2000);
      string(v.eventId, `${path}.eventId`, 200, true);
      number(v.visitedAt, `${path}.visitedAt`);
      if (
        v.visitedAt === undefined ||
        ![
          "navigation",
          "history_backfill",
          "activation",
          "attention",
          "close",
          "session_end",
          "goal",
        ].includes(v.kind)
      )
        fail(path);
      break;
    case "public_page_capture":
      url(v.url, `${path}.url`);
      string(v.title, `${path}.title`, 2000);
      break;
    case "history_item":
      string(v.id, `${path}.id`, 200);
      url(v.url, `${path}.url`);
      string(v.title, `${path}.title`, 2000);
      number(v.visitTime, `${path}.visitTime`);
      break;
    case "bookmark_item":
      url(v.url, `${path}.url`);
      string(v.id, `${path}.id`, 200, true);
      string(v.title, `${path}.title`, 2000);
      string(v.folderPath, `${path}.folderPath`, 2000);
      string(v.parentId, `${path}.parentId`, 200);
      if (v.folders !== undefined)
        array(v.folders, `${path}.folders`, 30, (x, p) => {
          if (!object(x)) fail(p);
          string(x.id, `${p}.id`, 200, true);
          string(x.title, `${p}.title`, 500);
          string(x.parentId, `${p}.parentId`, 200);
        });
      break;
    case "catalog_delete":
      if (!["history", "bookmark"].includes(v.catalog)) fail(path);
      if (v.all !== undefined && typeof v.all !== "boolean") fail(path);
      if (v.ids !== undefined)
        array(v.ids, `${path}.ids`, 100, (x, p) => string(x, p, 200, true));
      if (v.urls !== undefined)
        array(v.urls, `${path}.urls`, 100, (x, p) => url(x, p));
      if (!v.all && !v.ids?.length && !v.urls?.length) fail(path);
      break;
    default:
      fail(`${path}.type`);
  }
}
export function validateBrowserPayload(
  value: unknown,
): asserts value is BrowserIngestPayload {
  if (!object(value)) fail("payload");
  if (
    new TextEncoder().encode(JSON.stringify(value)).length > MAX_BROWSER_BYTES
  )
    throw new BrowserProtocolError("Browser payload too large", 413);
  if (value.type === "browser_batch") {
    if (value.protocolVersion !== BROWSER_PROTOCOL_VERSION)
      throw new BrowserProtocolError(
        "Unsupported browser protocol version",
        409,
      );
    string(value.collectorId, "collectorId", 200, true);
    string(value.batchId, "batchId", 200, true);
    array(value.records, "records", MAX_BROWSER_RECORDS, (x, p) => {
      record(x, p, true);
      if (x.collectorId !== undefined && x.collectorId !== value.collectorId)
        fail(`${p}.collectorId`);
    });
    if (!value.records.length) fail("records");
    const ids = value.records.map((x: any) => x.recordId);
    if (new Set(ids).size !== ids.length) fail("duplicate recordId");
    return;
  }
  switch (value.type) {
    case "tabs_batch":
    case "pages_batch":
      array(value.pages, "pages", 100, (x, p) => record(x, p));
      break;
    case "history_batch":
      array(value.items, "items", 1000, (x, p) =>
        record({ ...x, type: "history_item" }, p),
      );
      break;
    case "bookmarks_batch":
      array(value.items, "items", 1000, (x, p) =>
        record({ ...x, type: "bookmark_item" }, p),
      );
      break;
    case "session_snapshot":
    case "session_end":
      identity(value, "session");
      string(value.sessionId, "sessionId", 200, true);
      number(value.startTime, "startTime");
      array(value.pages, "pages", 500, (x, p) => {
        if (!object(x)) fail(p);
        url(x.url, `${p}.url`);
        identity(x, p);
        string(x.title, `${p}.title`, 2000);
      });
      break;
    case "ping":
      break;
    default:
      record(value, "payload");
  }
}
