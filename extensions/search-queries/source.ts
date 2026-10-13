/**
 * One source per engine + normalised query. Its summary names the search and what was opened;
 * its snippets are Google's AI Overview (when shown) and one snippet per opened result.
 */
import type { ShaleSDK } from "@shale/sdk";
import { SourceGraph } from "@shale/sdk/graph/source";
import { contentFingerprint, memoryChunks, validateMemory } from "../../lib/memory/prepare";
import { MEMORY_LIMITS, type PreparedSnippet, type PreparedSourceMemory } from "../../lib/memory/types";
import { ENGINES, cleanUrl, sha256, type AiOverview } from "./contract";
import { markIndexed, overviewOf, resultsOf, visitsFor, type QueryRow, type VisitRow } from "./store";

export const SEARCH_SOURCE_TYPE = "web_search";
export const SEARCH_ORIGIN = "search";
/** The overview takes at most this many snippets; opened results get the rest. */
const MAX_OVERVIEW_SNIPPETS = 4;
/** Locators stay compact provenance, not copies of long URLs. */
const LOCATOR_URL_CHARS = 1000;

const day = (time: number) => new Date(time).toISOString().slice(0, 10);
const domain = (url: string) => {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
};

export const searchUri = (row: Pick<QueryRow, "engine" | "query_key">) =>
  `search://${row.engine}/${encodeURIComponent(row.query_key)}`;
export async function searchSourceId(row: Pick<QueryRow, "engine" | "query_key">) {
  return `search:${row.engine}:${(await sha256(row.query_key)).slice(0, 24)}`;
}

/** Cut text into at most `parts` pieces of at most `max` characters, at line and then word boundaries. */
export function splitText(text: string, max: number, parts: number): string[] {
  const pieces: string[] = [];
  let rest = text.trim();
  while (rest && pieces.length < parts) {
    if (rest.length <= max) {
      pieces.push(rest);
      rest = "";
      break;
    }
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest && pieces.length) pieces[pieces.length - 1] = `${pieces.at(-1)!.slice(0, max - 1).trimEnd()}…`;
  return pieces.filter(Boolean);
}

function overviewSnippets(overview: AiOverview, capturedAt: number): PreparedSnippet[] {
  const max = MEMORY_LIMITS.snippet;
  const sources = overview.citations.length
    ? `\nSources:\n${overview.citations.slice(0, 8).map(c => `- ${c.title.slice(0, 120)} (${c.url.slice(0, 200)})`).join("\n")}` : "";
  const body = `Google AI Overview:\n${overview.text}`;
  // Citations ride on the last piece when they fit; otherwise they are trimmed to what does.
  const pieces = splitText(body, max, MAX_OVERVIEW_SNIPPETS);
  const last = pieces.length - 1;
  if (sources) {
    if (pieces[last]!.length + sources.length <= max) pieces[last] += sources;
    else if (pieces.length < MAX_OVERVIEW_SNIPPETS) pieces.push(sources.trim().slice(0, max));
  }
  return pieces.map((text, part) => ({
    text, kind: "excerpt", purpose: "ai overview", locator: { kind: "ai_overview", capturedAt, part },
  }));
}

function visitText(visit: VisitRow) {
  const lines = [visit.title?.trim() || domain(visit.url), visit.url];
  if (visit.description) lines.push(visit.description.trim());
  const text = lines.join("\n");
  return text.length <= MEMORY_LIMITS.snippet ? text : `${text.slice(0, MEMORY_LIMITS.snippet - 1)}…`;
}

/** Bounded memory for a search: summary, then overview snippets, then opened results, newest first. */
export function searchMemory(row: QueryRow, visits: VisitRow[]): PreparedSourceMemory {
  const label = ENGINES[row.engine].label;
  const overview = overviewOf(row);
  // Results pages describe each result; a visit sent before its page was read borrows that text.
  const listed = new Map(resultsOf(row).map(result => [cleanUrl(result.url), result]));
  const described = visits.map(visit => {
    const result = listed.get(visit.url);
    return { ...visit, title: visit.title || result?.title || null, description: visit.description || result?.description || null,
      rank: visit.rank ?? result?.rank ?? null };
  });

  const snippets: PreparedSnippet[] = overview?.text.trim() ? overviewSnippets(overview, row.ai_overview_at ?? row.last_searched_at) : [];
  let budget = MEMORY_LIMITS.snippetCharacters - snippets.reduce((n, s) => n + s.text.length, 0);
  const seen = new Set(snippets.map(s => s.text));
  const kept: typeof described = [];
  for (const visit of described) {
    if (snippets.length >= MEMORY_LIMITS.snippets) break;
    const text = visitText(visit);
    if (text.length > budget || seen.has(text)) continue;
    seen.add(text);
    budget -= text.length;
    kept.push(visit);
    snippets.push({ text, kind: "excerpt", purpose: "opened result", locator: {
      kind: "opened_result", url: visit.url.slice(0, LOCATOR_URL_CHARS), rank: visit.rank ?? undefined,
      firstVisitedAt: visit.first_visited_at, lastVisitedAt: visit.last_visited_at, visitCount: visit.visit_count,
    } });
  }

  const times = row.search_count > 1
    ? ` ${row.search_count} times between ${day(row.first_searched_at)} and ${day(row.last_searched_at)}`
    : ` on ${day(row.first_searched_at)}`;
  const parts = [`Searched ${label} for "${row.query}"${times}.`];
  if (overview?.text.trim()) parts.push(`${label} showed an AI Overview.`);
  if (described.length) {
    const names = described.map(v => `${v.title?.trim() || v.url} (${domain(v.url)})`);
    parts.push(`Opened ${described.length} result${described.length === 1 ? "" : "s"}: ${names.join("; ")}.`);
  } else parts.push("No results were opened.");
  let summary = parts.join(" ");
  if (summary.length > MEMORY_LIMITS.summaryTarget) summary = `${summary.slice(0, MEMORY_LIMITS.summaryTarget - 1)}…`;

  const memory: PreparedSourceMemory = {
    summary, summaryMethod: "metadata", snippets,
    coverage: { inputCharacters: (overview?.text.length ?? 0) + described.reduce((n, v) => n + visitText(v).length, 0),
      sections: (overview ? 1 : 0) + described.length, summarizedSections: kept.length + (overview ? 1 : 0), method: "search-log" },
  };
  validateMemory(memory);
  return memory;
}

/** Source, graph, and the cleared indexing mark commit together. */
export async function commitSearch(sdk: ShaleSDK, row: QueryRow, namespace: string) {
  const visits = visitsFor(sdk.database, row);
  const memory = searchMemory(row, visits);
  const chunks = memoryChunks(memory);
  const uri = searchUri(row);
  const id = await searchSourceId(row);
  const label = ENGINES[row.engine].label;
  const lastActivity = Math.max(row.last_searched_at, ...visits.map(v => v.last_visited_at));
  const title = `${row.query.slice(0, 400)} (${label} search)`;
  const result = sdk.database.transaction(() => {
    const result = sdk.ingest.sourceAndChunks({
      namespace,
      source: { id, type: SEARCH_SOURCE_TYPE, uri, origin: SEARCH_ORIGIN, title,
        created_at: row.first_searched_at, updated_at: lastActivity, hash: contentFingerprint(chunks) },
      chunks, memory,
    });
    if (!result.skipped) {
      const graph = new SourceGraph(sdk.database, sdk.graph, result.sourceId, namespace, lastActivity);
      const search = graph.entity(`${row.engine}:${row.query_key}`, row.query, "SearchQuery");
      graph.claim(search, "SOURCE_URI", { value: uri });
      graph.claim(search, "SEARCH_ENGINE", { value: label });
      const pages = visits.map(visit => {
        const page = graph.entity(visit.url, visit.title?.trim() || visit.url, "WebPage");
        graph.link(search, "OPENED_RESULT", page, { qualifiers: { visitCount: visit.visit_count, lastVisitedAt: visit.last_visited_at } });
        return page;
      });
      graph.event(`search:${row.engine}:${row.query_key}`, {
        name: `Searched ${label} for "${row.query.slice(0, 200)}"`, kind: "search",
        occurredFrom: row.first_searched_at, occurredTo: lastActivity,
        participants: [{ entity: search, role: "record" }, ...pages.map((entity, position) => ({ entity, role: "opened", position }))],
      });
    }
    markIndexed(sdk.database, row, result.skipped ? null : result.sourceId);
    return result;
  })();
  return { ...result, uri, title, chunksCount: result.chunksCount };
}
