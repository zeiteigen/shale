# Search queries

Turns your web searches on **Google**, **Bing**, and **DuckDuckGo** into sources:
- **One source per search.** A search is an engine plus a normalised query, so searching for "Rust lifetimes" again next week updates the same source.
- **Opened results become snippets.** Each result you open from the search is added to its source.
- **Google's AI Overview** becomes a snippet too.

Capture runs in the [Shale Chrome extension](../../scripts/browser-chrome-extension/README.md) through this extension's module (`chrome/`).

## Setup

1. Start Shale (`bun run main/index.ts`). This extension loads automatically.
2. Run `bun run browser:build`, then load or **Reload** the unpacked extension from `scripts/browser-chrome-extension` in `chrome://extensions`.
3. Search as usual. The popup's **Search queries** section shows the last captured search and has a **Capture this search** button.

## What is captured

**Results pages.** A results page is read once it has loaded:
- the top 20 organic results, with their titles and the engine's description;
- on Google, the AI Overview.

The overview streams in, so the module waits until its text stops changing, and reads the page again later if it was still being written. Collapsed text behind "Show more" is included, along with the overview's source links. Every selector lives in `chrome/inject/serp.ts`.

**Opened results.** A navigation counts as opening a result when you click a link on the results page, either in the same tab or in a new tab opened from it (middle-click, Ctrl-click).
- Engine click trackers (`google.com/url`, `bing.com/ck/a`, `duckduckgo.com/l/`) and the result's own script redirects are followed, so they count once.
- Links you follow further from the result do not count.
- Neither do typed URLs, Back/Forward, or the engine's own tabs such as Images.
- Paging through results, going Back to the results, or reloading them continues the same search.

**Not captured:**
- **Incognito tabs.**
- **Engines removed from `engines`.** Their results pages are still claimed, but nothing is sent.
- **Image and shopping verticals.** These are not treated as searches.

While this module is enabled, the browser module does not also capture results pages as ordinary web pages. Pages you open from a search are still captured by the browser module as usual.

## Indexing

Records arrive at `POST /ingest` with `target_processor: "search-queries"`. The wire contract is in `contract.ts` and is shared with the Chrome module. Admission writes them to a raw log:
- `search_queries`: one row per engine and normalised query, holding the newest results and AI Overview;
- `search_events`: one row per distinct search, used to count them;
- `search_visits`: one row per opened URL, with its visit count.

Scoped access profiles cannot see these tables, only the sources built from them.

The `search-queries-index` cron runs every 2 minutes. It writes a source for each search that has been quiet for `settleMinutes`, so results opened shortly after a search land in a single update. Each source has:
- **Identity:** type `web_search`, origin `search`, URI `search://<engine>/<normalised query>`.
- **Summary:** when and how often you searched, and which results you opened.
- **Snippets:** up to 4 for the AI Overview (with its sources), then one per opened result, newest first: its title, URL, and the engine's description. If the snippet budget runs out (16 snippets, 12,000 characters), older results are named only in the summary.
- **Graph:** a `SearchQuery` entity with `OPENED_RESULT` links to a `WebPage` entity for each result, and a `search` event.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `engines` | `["google","bing","duckduckgo"]` | Engines the module captures and the server accepts |
| `captureAiOverview` | `true` | Keep Google's AI Overview |
| `settleMinutes` | `5` | Quiet time before a search's source is written |
| `maxQueriesPerRun` | `200` | Searches indexed per cron run |
| `namespace` | `search-queries` | Namespace for sources and graph entities |

To add an engine, add an entry to `ENGINES` in `contract.ts` and its selectors to `chrome/inject/serp.ts`.
