/**
 * Search queries module for the Shale Chrome extension. Recognises search result pages on the
 * engines in contract.ts and sends them to the `search-queries` Shale extension:
 * - each results page becomes a `search_query` record, with Google's AI Overview when shown;
 * - each result the user opens from that page (same tab, or a new tab opened from it)
 *   becomes a `search_visit` record. Only direct clicks count, not links followed further on.
 * Results pages are claimed, so the browser module does not also capture them as web pages.
 */
import {
  ENGINES, ENGINE_IDS, SEARCH_PROTOCOL_VERSION, cleanUrl, isSearchRedirect, parseSearchUrl, queryKey, searchEngineOf,
  sha256, validateSearchBatch, type AiOverview, type Engine, type SearchQueryRecord, type SearchResult,
  type SearchVisitRecord,
} from "../contract";
import type { ModuleDefinition, ModuleRuntime } from "./types";

const TABS_KEY = "module:search-queries:tabs";
/** Wait for a results page updated in place, which fires no completed load. */
const SCRAPE_DELAY_MS = 3000;
/** A results page whose AI Overview was still generating is read again after this long. */
const RESCRAPE_MS = 20_000;
const MAX_SCRAPES = 3;
/** A visit whose page never finishes loading is sent with its URL alone after this long. */
const VISIT_FLUSH_MS = 2 * 60_000;
const DEFAULT_POLICY = { engines: ENGINE_IDS as string[], captureAiOverview: true };

interface SearchRef {
  searchId: string;
  engine: Engine;
  query: string;
  searchedAt: number;
  results: SearchResult[];
}
interface PendingVisit {
  visitId: string;
  search: Omit<SearchRef, "results">;
  url: string;
  visitedAt: number;
  rank?: number;
  description?: string;
}
interface TabState {
  /** The last search made in this tab; kept after leaving it so Back resumes the same search. */
  search?: SearchRef;
  /** The tab is showing `search`'s results, so its next link navigation is a result click. */
  onSerp: boolean;
  serpUrl?: string;
  pendingSerp?: { dueAt: number; scrapes: number };
  pendingVisit?: PendingVisit;
}
interface Status { lastQuery?: string; lastEngine?: string; lastSearchAt?: number; visits?: number; error?: string }
interface ScrapedPage {
  url: string;
  results: SearchResult[];
  overview?: AiOverview & { complete: boolean };
  error?: string;
}

const sameSearch = (a: { engine: Engine; query: string } | undefined, b: { engine: Engine; query: string }) =>
  !!a && a.engine === b.engine && queryKey(a.query) === queryKey(b.query);

export default function register(runtime: ModuleRuntime): ModuleDefinition {
  const policy = async () => ({ ...DEFAULT_POLICY, ...(await runtime.policy()) });

  async function setStatus(patch: Status) {
    const current = await runtime.storage.get<Status>("status", {});
    await runtime.storage.set("status", { ...current, ...patch });
  }

  // Tab state lives in session storage, so it survives a service-worker restart.
  async function tabs(): Promise<Record<string, TabState>> {
    const saved = await chrome.storage.session.get(TABS_KEY);
    return (saved[TABS_KEY] as Record<string, TabState> | undefined) ?? {};
  }
  const saveTabs = (state: Record<string, TabState>) => chrome.storage.session.set({ [TABS_KEY]: state });

  // Listeners interleave across awaits; one queue keeps each read-modify-write of the tab state whole.
  let queue: Promise<unknown> = Promise.resolve();
  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work);
    queue = next.catch(error => runtime.log(error));
    return next;
  }

  async function sendVisit(visit: PendingVisit, title?: string) {
    const { search } = visit;
    const record: SearchVisitRecord = {
      type: "search_visit", recordId: `visit:${visit.visitId}`, searchId: search.searchId, engine: search.engine,
      query: search.query, url: visit.url, searchedAt: search.searchedAt, visitedAt: visit.visitedAt,
      ...(title?.trim() ? { title: title.trim().slice(0, 2000) } : {}),
      ...(visit.description ? { description: visit.description } : {}),
      ...(visit.rank ? { rank: visit.rank } : {}),
    };
    await runtime.enqueue([record]);
    const status = await runtime.storage.get<Status>("status", {});
    await setStatus({ visits: (status.visits ?? 0) + 1 });
  }

  /** Read a results page and queue it; an unchanged recapture produces the same record id. */
  async function scrape(tabId: number, entry: TabState) {
    const search = entry.search!;
    const { captureAiOverview } = await policy();
    const wantOverview = search.engine === "google" && captureAiOverview;
    const page = await runtime.inject<ScrapedPage>(tabId, "serp", { args: { engine: search.engine, overview: wantOverview } });
    if (!page || page.error) throw new Error(page?.error ?? "Could not read the results page");
    const tab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (!tab || tab.url !== entry.serpUrl || page.url !== entry.serpUrl) return { done: true, results: search.results };
    const results = page.results.slice(0, 20);
    const aiOverview = wantOverview && page.overview?.text.trim()
      ? { text: page.overview.text, citations: page.overview.citations } : undefined;
    const record: SearchQueryRecord = {
      type: "search_query",
      recordId: `search:${search.searchId}:${(await sha256(JSON.stringify({ results, aiOverview }))).slice(0, 24)}`,
      searchId: search.searchId, engine: search.engine, query: search.query, url: entry.serpUrl!,
      searchedAt: search.searchedAt, results, ...(aiOverview ? { aiOverview } : {}),
    };
    if (!(await runtime.hasRecord(record.recordId))) await runtime.enqueue([record]);
    await setStatus({ lastQuery: search.query, lastEngine: ENGINES[search.engine].label, lastSearchAt: search.searchedAt, error: "" });
    // An overview still being written is read again shortly.
    return { done: !wantOverview || !page.overview || page.overview.complete, results };
  }

  /**
   * Scrape a tab's due results page. Reading a page can wait several seconds for its AI Overview,
   * so it runs outside the listener queue; only the state updates around it are serialized.
   */
  const scraping = new Set<number>();
  async function scrapeTab(tabId: number): Promise<string | undefined> {
    const entry = await serialize(async () => {
      const current = (await tabs())[tabId];
      if (!current?.onSerp || !current.pendingSerp || current.pendingSerp.dueAt > Date.now() || scraping.has(tabId)) return;
      scraping.add(tabId);
      return current;
    });
    if (!entry) return;
    let outcome: { done: boolean; results: SearchResult[] } | undefined, error: string | undefined;
    try {
      outcome = await scrape(tabId, entry);
    } catch (failure) {
      error = (failure as Error).message;
      await setStatus({ error });
      runtime.log("Results page capture failed:", failure);
    } finally {
      scraping.delete(tabId);
    }
    const again = await serialize(async () => {
      const state = await tabs();
      const current = state[tabId];
      // The tab moved on while the page was being read.
      if (!current?.pendingSerp || current.serpUrl !== entry.serpUrl || current.search?.searchId !== entry.search!.searchId)
        return false;
      if (outcome) current.search!.results = outcome.results;
      const scrapes = current.pendingSerp.scrapes + 1;
      const retry = !outcome?.done && scrapes < MAX_SCRAPES;
      if (retry) current.pendingSerp = { dueAt: Date.now() + RESCRAPE_MS, scrapes };
      else delete current.pendingSerp;
      await saveTabs(state);
      return retry;
    });
    await runtime.deliver();
    if (again) later(tabId, RESCRAPE_MS + 500);
    return error;
  }
  // A timer lost to a service-worker restart is covered by the minute alarm's sweep.
  const later = (tabId: number, delay: number) =>
    setTimeout(() => scrapeTab(tabId).catch(error => runtime.log(error)), delay);

  async function navigation(details: chrome.webNavigation.WebNavigationTransitionCallbackDetails) {
    if (details.frameId !== 0) return;
    const tab = await chrome.tabs.get(details.tabId).catch(() => undefined);
    if (!tab || tab.incognito) return;
    const { engines } = await policy();
    const state = await tabs();
    const known = state[details.tabId];
    const entry: TabState = known ?? { onSerp: false };
    const qualifiers = details.transitionQualifiers ?? [];
    const serp = parseSearchUrl(details.url);
    if (serp && engines.includes(serp.engine)) {
      if (entry.pendingVisit) await sendVisit(entry.pendingVisit);
      // Paging, Back, a reload, or an in-page update of the same query continue that search.
      const continues = sameSearch(entry.search, serp) && (entry.onSerp || qualifiers.includes("forward_back")
        || details.transitionType === "reload");
      const search: SearchRef = continues ? entry.search! : {
        searchId: crypto.randomUUID(), engine: serp.engine, query: serp.query, searchedAt: Math.round(details.timeStamp), results: [],
      };
      state[details.tabId] = { search, onSerp: true, serpUrl: details.url, pendingSerp: { dueAt: 0, scrapes: 0 } };
      await saveTabs(state);
      later(details.tabId, SCRAPE_DELAY_MS);
      return;
    }
    // The engine's click tracker forwards to the result; the result's own commit is the visit.
    // A new tab's initial about:blank is not its first page either.
    if (isSearchRedirect(details.url) || !/^https?:/i.test(details.url)) return;
    // A page's own script redirect replaces the URL of the visit it belongs to.
    if (entry.pendingVisit && qualifiers.includes("client_redirect")) {
      entry.pendingVisit.url = cleanUrl(details.url);
      state[details.tabId] = entry;
      await saveTabs(state);
      return;
    }
    if (entry.pendingVisit) await sendVisit(entry.pendingVisit);
    delete entry.pendingVisit;
    // A result opened in this tab, or the first page of a tab opened from a results page.
    const opener = !known && tab.openerTabId !== undefined ? state[tab.openerTabId] : undefined;
    const from = entry.onSerp ? entry : opener?.onSerp ? opener : undefined;
    // The engine's own tabs (Images, Maps, …) are not results.
    if (from?.search && details.transitionType === "link" && !qualifiers.includes("forward_back")
      && !searchEngineOf(details.url)) {
      const url = cleanUrl(details.url);
      const result = from.search.results.find(item => cleanUrl(item.url) === url);
      const { results: _results, ...search } = from.search;
      entry.pendingVisit = {
        visitId: crypto.randomUUID(), search, url, visitedAt: Math.round(details.timeStamp),
        rank: result?.rank, description: result?.description,
      };
    }
    entry.onSerp = false;
    delete entry.pendingSerp;
    state[details.tabId] = entry;
    await saveTabs(state);
  }

  async function completed(tabId: number, tab: chrome.tabs.Tab) {
    const state = await tabs();
    const entry = state[tabId];
    if (!entry?.pendingVisit || entry.onSerp) return;
    await sendVisit(entry.pendingVisit, tab.title);
    delete entry.pendingVisit;
    await saveTabs(state);
  }

  /** Send visits whose page never finished loading and forget closed tabs; returns results pages due a read. */
  async function sweep() {
    const state = await tabs();
    const due: number[] = [];
    for (const [id, entry] of Object.entries(state)) {
      const tab = await chrome.tabs.get(Number(id)).catch(() => undefined);
      if (entry.pendingVisit && (!tab || Date.now() - entry.pendingVisit.visitedAt > VISIT_FLUSH_MS)) {
        await sendVisit(entry.pendingVisit, tab?.url && cleanUrl(tab.url) === entry.pendingVisit.url ? tab.title : undefined);
        delete entry.pendingVisit;
      }
      if (!tab) delete state[id];
      else if (entry.pendingSerp && entry.pendingSerp.dueAt <= Date.now()) due.push(Number(id));
    }
    await saveTabs(state);
    return due;
  }
  async function wake() {
    for (const tabId of await serialize(sweep)) await scrapeTab(tabId);
    await runtime.deliver();
  }

  async function closed(tabId: number) {
    const state = await tabs();
    const entry = state[tabId];
    if (!entry) return;
    if (entry.pendingVisit) await sendVisit(entry.pendingVisit);
    delete state[tabId];
    await saveTabs(state);
  }

  return {
    id: "search-queries",
    label: "Search queries",
    protocol: { batchType: "search_batch", version: SEARCH_PROTOCOL_VERSION, validate: validateSearchBatch },
    // Only results pages: the rest of google.com and bing.com stays with the browser module.
    claims: { match: url => !!parseSearchUrl(url) },
    wake,
    async status() {
      const saved = await runtime.storage.get<Status>("status", {});
      const { engines } = await policy();
      return { ...saved, engines: ENGINE_IDS.filter(id => engines.includes(id)).map(id => ENGINES[id].label) };
    },
    listeners: {
      navigation: details => serialize(() => navigation(details)),
      async tabComplete(tabId, tab) {
        await serialize(() => completed(tabId, tab));
        await scrapeTab(tabId);
      },
      tabRemoved: tabId => serialize(() => closed(tabId)).then(() => runtime.deliver()),
      alarm: wake,
    },
    actions: {
      async capture_current() {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const serp = tab?.url ? parseSearchUrl(tab.url) : undefined;
        if (tab?.id === undefined || !serp) throw new Error("This tab is not a search results page");
        if (tab.incognito) throw new Error("Private browsing excluded");
        if (!(await policy()).engines.includes(serp.engine))
          throw new Error(`${ENGINES[serp.engine].label} capture is turned off in search-queries settings`);
        await serialize(async () => {
          const state = await tabs();
          const entry = state[tab.id!];
          state[tab.id!] = {
            search: sameSearch(entry?.search, serp) ? entry!.search : {
              searchId: crypto.randomUUID(), engine: serp.engine, query: serp.query, searchedAt: Date.now(), results: [] },
            onSerp: true, serpUrl: tab.url, pendingSerp: { dueAt: 0, scrapes: 0 },
          };
          await saveTabs(state);
        });
        const error = await scrapeTab(tab.id);
        if (error) throw new Error(error);
        return { success: true, title: serp.query };
      },
    },
  };
}
