/**
 * Wire contract between the Chrome module (chrome/) and the server (subscribe.ts).
 * Shared by both sides: the Chrome bundle validates before queueing, the server on admission.
 * Search engines are recognised here only, so supporting another one is one `ENGINES` entry.
 */
export const SEARCH_PROTOCOL_VERSION = 1;
export const MAX_SEARCH_BYTES = 1_000_000;
export const MAX_SEARCH_RECORDS = 100;
export const MAX_OVERVIEW_CHARS = 20_000;
export const MAX_RESULTS = 20;

interface EngineRule {
  label: string;
  host: RegExp;
  path: (pathname: string) => boolean;
  /** Result tabs that are not a web search (images, shopping). */
  vertical?: (params: URLSearchParams) => boolean;
  /** Click-tracking pages that forward to a result, and how to read the target from them. */
  redirect?: { path: RegExp; target: (params: URLSearchParams) => string | null };
}

const GOOGLE_HOST = /^(www\.)?google\.[a-z]{2,3}(\.[a-z]{2})?$/;

export const ENGINES = {
  google: {
    label: "Google",
    host: GOOGLE_HOST,
    path: pathname => pathname === "/search",
    vertical: params => ["isch", "shop"].includes(params.get("tbm") ?? "") || ["2", "28"].includes(params.get("udm") ?? ""),
    redirect: { path: /^\/url$/, target: params => params.get("q") || params.get("url") },
  },
  bing: {
    label: "Bing",
    host: /^(www\.)?bing\.com$/,
    path: pathname => pathname === "/search",
    // `u=a1<base64url of the target>`.
    redirect: { path: /^\/ck\/a$/, target: params => {
      const encoded = params.get("u");
      if (!encoded?.startsWith("a1")) return null;
      try {
        return atob(encoded.slice(2).replace(/-/g, "+").replace(/_/g, "/"));
      } catch {
        return null;
      }
    } },
  },
  duckduckgo: {
    label: "DuckDuckGo",
    host: /^(html\.|lite\.)?duckduckgo\.com$/,
    path: pathname => pathname === "/" || pathname === "/html/" || pathname === "/lite/",
    vertical: params => !!params.get("iax") && params.get("iax") !== "web",
    redirect: { path: /^\/l\/$/, target: params => params.get("uddg") },
  },
} satisfies Record<string, EngineRule>;
export type Engine = keyof typeof ENGINES;
export const ENGINE_IDS = Object.keys(ENGINES) as Engine[];

function parse(value: string | URL): URL | undefined {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url : undefined;
  } catch {
    return undefined;
  }
}

function engineFor(url: URL): Engine | undefined {
  const host = url.hostname.toLowerCase();
  return ENGINE_IDS.find(engine => ENGINES[engine].host.test(host));
}

/** The engine whose own site this is (any page on it), if any. */
export function searchEngineOf(value: string | URL): Engine | undefined {
  const url = parse(value);
  return url && engineFor(url);
}

/** The engine and query of a search results page, or undefined for any other URL. */
export function parseSearchUrl(value: string | URL): { engine: Engine; query: string } | undefined {
  const url = parse(value);
  const engine = url && engineFor(url);
  if (!url || !engine) return undefined;
  const rule: EngineRule = ENGINES[engine];
  const query = url.searchParams.get("q")?.trim();
  if (!query || !rule.path(url.pathname) || rule.vertical?.(url.searchParams)) return undefined;
  return { engine, query: query.slice(0, 2048) };
}

/** Normalised identity of a query: repeats of one search share a source. */
export function queryKey(query: string): string {
  return query.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/** True for an engine's click-tracking page, which forwards to the result the user chose. */
export function isSearchRedirect(value: string | URL): boolean {
  const url = parse(value);
  const engine = url && engineFor(url);
  const redirect = engine && (ENGINES[engine] as EngineRule).redirect;
  return !!url && !!redirect && redirect.path.test(url.pathname);
}

/** The result behind an engine's click-tracking URL; other URLs are returned unchanged. */
export function unwrapRedirect(value: string): string {
  const url = parse(value);
  const engine = url && engineFor(url);
  const redirect = engine && (ENGINES[engine] as EngineRule).redirect;
  if (!url || !redirect || !redirect.path.test(url.pathname)) return value;
  const target = redirect.target(url.searchParams);
  return target && parse(target) ? target : value;
}

const TRACKING = new Set(["fbclid", "gclid", "msclkid", "srsltid", "ved", "usg", "sa", "_hsenc", "_hsmi", "mc_cid", "mc_eid"]);

/** Drop fragments and tracking parameters, so one result visited twice is one URL. */
export function cleanUrl(value: string): string {
  const url = parse(unwrapRedirect(value));
  if (!url) return value;
  url.hash = "";
  for (const key of [...url.searchParams.keys()])
    if (TRACKING.has(key.toLowerCase()) || key.toLowerCase().startsWith("utm_")) url.searchParams.delete(key);
  return url.href;
}

export interface SearchResult {
  url: string;
  title: string;
  description?: string;
  rank: number;
}

export interface AiOverview {
  text: string;
  citations: Array<{ title: string; url: string }>;
}

/** One results page as the user saw it. Recaptures of one search share `searchId`. */
export interface SearchQueryRecord {
  type: "search_query";
  recordId: string;
  searchId: string;
  engine: Engine;
  query: string;
  url: string;
  searchedAt: number;
  aiOverview?: AiOverview;
  results: SearchResult[];
}

/** A result the user opened from a search. */
export interface SearchVisitRecord {
  type: "search_visit";
  recordId: string;
  searchId: string;
  engine: Engine;
  query: string;
  url: string;
  title?: string;
  description?: string;
  rank?: number;
  /** Original search time, even if this visit reaches admission before the results page. */
  searchedAt?: number;
  visitedAt: number;
}

export type SearchRecord = SearchQueryRecord | SearchVisitRecord;

export interface SearchBatch {
  type: "search_batch";
  protocolVersion: number;
  collectorId: string;
  batchId: string;
  records: SearchRecord[];
}

export class SearchProtocolError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
function fail(path: string): never {
  throw new SearchProtocolError(`Invalid search field: ${path}`);
}
function string(v: unknown, path: string, max: number, required = true) {
  if (v === undefined && !required) return;
  if (typeof v !== "string" || v.length > max || (required && !v.trim())) fail(path);
}
function id(v: unknown, path: string) {
  if (typeof v !== "string" || !/^[\w.:@/+=-]{1,200}$/.test(v)) fail(path);
}
function time(v: unknown, path: string) {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) fail(path);
}
function rank(v: unknown, path: string, required = false) {
  if (v === undefined && !required) return;
  if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > 1000) fail(path);
}
function webUrl(v: unknown, path: string) {
  string(v, path, 4096);
  if (!parse(v as string)) fail(path);
}
function array(v: unknown, path: string, max: number, check: (item: any, path: string) => void) {
  if (!Array.isArray(v) || v.length > max) fail(path);
  v.forEach((item, i) => check(item, `${path}[${i}]`));
}

function result(v: unknown, path: string) {
  if (!object(v)) fail(path);
  webUrl(v.url, `${path}.url`);
  if (typeof v.title !== "string") fail(`${path}.title`);
  string(v.title, `${path}.title`, 1000, false);
  string(v.description, `${path}.description`, 2000, false);
  rank(v.rank, `${path}.rank`, true);
}

function overview(v: unknown, path: string) {
  if (!object(v)) fail(path);
  string(v.text, `${path}.text`, MAX_OVERVIEW_CHARS);
  array(v.citations, `${path}.citations`, 50, (citation, at) => {
    if (!object(citation)) fail(at);
    if (typeof citation.title !== "string") fail(`${at}.title`);
    string(citation.title, `${at}.title`, 1000, false);
    webUrl(citation.url, `${at}.url`);
  });
}

export function validateRecord(v: unknown, path = "record"): asserts v is SearchRecord {
  if (!object(v) || (v.type !== "search_query" && v.type !== "search_visit")) fail(`${path}.type`);
  string(v.recordId, `${path}.recordId`, 300);
  id(v.searchId, `${path}.searchId`);
  if (!ENGINE_IDS.includes(v.engine)) fail(`${path}.engine`);
  string(v.query, `${path}.query`, 2048);
  webUrl(v.url, `${path}.url`);
  if (v.type === "search_query") {
    if (parseSearchUrl(v.url)?.engine !== v.engine) fail(`${path}.url`);
    time(v.searchedAt, `${path}.searchedAt`);
    if (v.aiOverview !== undefined) overview(v.aiOverview, `${path}.aiOverview`);
    array(v.results, `${path}.results`, MAX_RESULTS, result);
  } else {
    if (v.searchedAt !== undefined) time(v.searchedAt, `${path}.searchedAt`);
    string(v.title, `${path}.title`, 2000, false);
    string(v.description, `${path}.description`, 2000, false);
    rank(v.rank, `${path}.rank`);
    time(v.visitedAt, `${path}.visitedAt`);
  }
}

export function validateSearchBatch(v: unknown): SearchBatch {
  if (!object(v) || v.type !== "search_batch") fail("type");
  if (v.protocolVersion !== SEARCH_PROTOCOL_VERSION)
    throw new SearchProtocolError(`Unsupported search protocol version ${v.protocolVersion}`, 409);
  if (new TextEncoder().encode(JSON.stringify(v)).length > MAX_SEARCH_BYTES)
    throw new SearchProtocolError("Search batch is too large", 413);
  string(v.collectorId, "collectorId", 200);
  string(v.batchId, "batchId", 200);
  if (!Array.isArray(v.records) || !v.records.length || v.records.length > MAX_SEARCH_RECORDS) fail("records");
  v.records.forEach((record: unknown, i: number) => validateRecord(record, `records[${i}]`));
  if (new Set(v.records.map((r: SearchRecord) => r.recordId)).size !== v.records.length) fail("records.recordId");
  return v as SearchBatch;
}

/** Hex SHA-256, available in both the service worker and Bun. */
export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}
