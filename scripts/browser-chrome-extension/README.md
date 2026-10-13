# Shale Browser Ingestor

Chrome/Chromium 106 or newer. The extension is a shared core that hosts **modules** contributed by Shale extensions:
- **Browser** (`extensions/browser/chrome`) captures readable page content, navigation and attention observations, bookmarks, and history.
- **AI chats** (`extensions/ai-chats/chrome`) captures ChatGPT, Claude, and Gemini conversations from tabs where you are signed in; see [its README](../../extensions/ai-chats/README.md).
- **Search queries** (`extensions/search-queries/chrome`) captures Google, Bing, and DuckDuckGo searches, the results you open from them, and Google's AI Overview; see [its README](../../extensions/search-queries/README.md).
- **YouTube** (`extensions/youtube/chrome`) captures watched video metadata and full transcript summaries after 50% unique playback; see [its README](../../extensions/youtube/README.md).

## Install or upgrade

1. Run `bun install` and `bun run browser:build` from the repository root.
2. Start Shale with `bun run main/index.ts` (or `--no-cli`).
3. Open `chrome://extensions`, enable Developer mode, and load `scripts/browser-chrome-extension` unpacked. For an existing installation, click **Reload**.
4. Open the popup and verify **Connector ready**. The default endpoint is `http://127.0.0.1:7425/ingest`; previously saved endpoints remain unchanged.
5. Choose the data to import. Import commands return immediately; reopening the popup shows persisted progress. Initial setup does not start a library import automatically.

Upgrade the server before the Chrome extension. The connection test checks Shale identity, then each module's processor: durable admission, protocol version, and capture policy. A generic HTTP success is insufficient. A module whose Shale extension is not loaded is marked unavailable in its popup section; its captures stay queued until the server accepts them. Each module can be turned off under **Settings**.

## Modules

The core (`background.js`, `outbox.js`, `delivery.js`, `jobs.js`, `core/module-host.js`, `popup.*`) owns:
- Chrome listeners;
- the durable outbox;
- delivery and receipts;
- resumable jobs;
- the popup shell.

It contains nothing specific to one Shale extension. Each extension declares its module in its manifest:

```json
"chrome_module": {
  "background": "chrome/background.ts",
  "popup": "chrome/popup.ts",
  "inject": { "reader": "chrome/inject/reader.ts" }
}
```

**Background entry.** It default-exports `register(runtime)`, which returns:
- `id`: the extension name, which is also the `/ingest` processor.
- `protocol`: `{ batchType, version, validate }`. Records are validated when queued and sent as `{ type: batchType, protocolVersion: version, collectorId, batchId, records }` with `target_processor: id`.
- `claims`: what the module owns. Other modules, such as browser capture, skip it while the module is enabled.
  - `hosts`: whole hosts, such as `chatgpt.com`.
  - `match(url)`: a predicate for individual URLs, such as search results pages, which leaves the rest of the host to other modules.
- `listeners`: `navigation`, `tabComplete`, `tabActivated`, `windowFocus`, `tabRemoved`, `idle`, `alarm` (each minute), `bookmark*`, `history*`.
- `actions`: popup commands, sent as `<id>:<action>`.
- `jobs`: `{ kind: { step(job), summary(job), stepsPerWake? } }` for resumable work.
- `wake`, `status`, `defaults`.

**Runtime.** The `runtime` is scoped to the module:
- `enqueue(records)`, `hasRecord`, `deliver()`;
- `storage.get/set` (prefixed with the module id);
- `policy()`, from `/connectors/<id>/policy`;
- `createJob(kind, fields)` and `resume()`;
- `inject(tabId, name, { documentId, args, world })`, where `world` is `"ISOLATED"` (the default) or `"MAIN"` and applies to both injection phases;
- `execInTab(tabId, func, args)`;
- `claimedByOther(url)`.

Delivery batches never mix processors. Receipts are polled at `/connectors/<id>/status`, and retries go to `/connectors/<id>/retry`.

**Popup and inject entries.** A popup entry exports `render(container, popup)` and may return `{ refresh(status, module) }`. Inject entries default-export a function of one argument; the core registers it in the page and calls it.

**Build.** `bun run browser:build` bundles every module into `modules/` and writes static registries, since MV3 service workers cannot import dynamically. The output is committed. Reload the unpacked extension after rebuilding.

## Capture and delivery

Page captures and activity events are written to IndexedDB before HTTP delivery. Each record has an immutable ID and a stored destination. Network failures, timeouts, overload, and transient server failures use persisted backoff; a one-minute alarm resumes delivery and imports. The server's acknowledgement means SQLite admission, while **indexed** means a searchable commit. Permanent failures remain visible and can be retried after correction.

The popup distinguishes locally queued records, server indexing, indexed receipts, skips, and failures. Receipt history is bounded to the latest 1,000 terminal records; the lifetime received counter remains cumulative. The outbox allows at most 10,000 unresolved records and 50 MB of retained unresolved data. A full queue pauses imports with a visible error. Changing the endpoint preserves existing queued destinations; restore an import's original destination before resuming it.

Live collection uses top-frame committed navigation and SPA route events. Completed loads trigger document-bound extraction rather than creating another visit. Repeated A→B→A navigation keeps three event IDs, even when content analysis is reused. Activation, window focus, idle state, and bounded attention intervals provide context without collecting keystrokes or form input. A background window does not count as attended.

Extraction waits for bounded DOM settling and preserves headings, paragraphs, lists, tables, code whitespace, quotations, and captions. Navigation clutter, forms, hidden content, and executable attributes are removed. Injection failures produce labelled metadata captures with a diagnostic reason. Content is bounded and reports quality/truncation. Chrome's scripting result is verified against the expected URL/document before persistence.

## Privacy and goals

Incognito tabs are excluded before extraction or durable storage. Custom excluded domains combine with the server's policy. Until policy is available, built-in exclusions cover common mail, login, and banking URL patterns. A cached server policy remains available offline; server admission rechecks current policy and explains terminal skips.

**Researching** attaches an optional explicit goal to new activity. The server groups observed sessions by collector, browser instance, inactivity, and bounded size. A session may contain several research threads; a goal can continue across sessions. Inferred labels remain proposals. Existing event assignments can be renamed, merged, or split through the server's context API without changing raw observations.

## History and bookmarks

Open tabs provide live DOM content. History and bookmarks provide catalog metadata, not archived page bodies or historical attention.

History import uses persisted time windows and bisects saturated windows rather than dropping timestamp ties. Saturation at a single timestamp is reported as incomplete. Optional **Backfill individual visits** calls `history.getVisits()` for enumerated URLs, filters the requested interval, and limits each URL to 500 visits. These records use `history_backfill`, have no live tab/attention evidence, and do not create inferred navigation edges. Chrome API enumeration limits remain visible; this is not a promise of a complete historical archive.

Bookmark folders use collector-scoped Chrome IDs, preserving folder labels containing slashes. Create, change, move, and remove events update current catalog state. Each imported bookmark snapshot has a sequence, so an older paused import cannot undo a newer move or deletion. History updates and removals are also observed. Removed catalog evidence is retained by default; configure `retainRemovedCatalogEvidence` on the server to change that policy.

Public-page enrichment is a separate, explicit server job, disabled by default. It uses no browser cookies and stores fetched evidence separately from live captures. See [browser server documentation](../../extensions/browser/README.md).

## Developer checks

```bash
bun run browser:build       # Bundle extension modules into modules/
bun run browser:check       # Reject stale generated modules
bun run test:browser        # Server, extraction, outbox, retrieval regressions
bun run test:browser:chrome # Actual unpacked extension with an isolated Chromium profile
```

The Chromium test uses `/usr/bin/chromium` by default; set `SHALE_CHROMIUM_PATH` for another compatible executable. It uses temporary databases/profiles and mocked model endpoints, testing hydrated pages, offline host recovery, service-worker termination, profile restart, popup closure, receipts, and indexing. It does not contact a production daemon or model endpoint.
