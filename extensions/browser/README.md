# Browser connector

Durable browser ingestion for Shale's local SQLite, search, and evidence graph. The companion [Chrome extension](../../scripts/browser-chrome-extension/README.md) collects structured page captures and immutable activity observations. Catalog records, page content, activity, observed sessions, and inferred research threads have separate identities.

## Admission and processing

`subscribe.ts` exports fast `accept`, status/policy inspection, and capabilities. The host validates the outer envelope, then awaits browser validation and the SQLite transaction before returning `202`. Browser work bypasses the volatile host queue. Legacy payloads remain supported; their missing identities cannot provide the replay guarantees of versioned records.

A versioned request contains an `IngestMaterial` envelope:

```json
{
  "target_processor": "browser",
  "content": "{\"type\":\"browser_batch\",\"protocolVersion\":1,\"collectorId\":\"profile-1\",\"batchId\":\"batch-1\",\"records\":[{\"type\":\"page_visit\",\"recordId\":\"capture-1\",\"url\":\"https://example.com/docs\",\"title\":\"Documentation\",\"textContent\":\"Readable captured evidence.\",\"recordInSession\":false}]}",
  "metadata": {
    "connector": "chrome-extension",
    "data_origin": "chrome",
    "time": 1790812800000
  }
}
```

The receipt contains `protocolVersion`, `collectorId`, `batchId`, and `records` with `recordId`, `jobId`, `status` (`received`, `duplicate`, or `skipped`), and optional reason. An identical record replay returns the original job. Reusing an ID with changed content returns `409`; the entire request rolls back. Invalid nested payloads return `400`, oversized requests `413`, unknown subscribers `404`, capacity exhaustion `429`, and failed durable storage `503`. Overload/transient responses include `Retry-After`.

`storage-schema.ts` creates browser-owned tables additively. The legacy `pending-ingest` and `active_session_state` are migrated transactionally and removed only after durable rows exist. Queue capacity uses an indexed byte counter, avoiding scans of retained page bodies. Previously coalesced visits cannot be reconstructed.

Admission wakes a coalescing background worker, with a one-minute cron and startup run as recovery fallbacks. Bounded jobs run inside `sdk.models.batch`: all chat/vision preparation and checkpoints finish before embeddings begin. Compatible text arrays are embedded with explicit request limits. A renewable SQLite lease prevents concurrent owners, and ownership is checked around long calls and before commits. Sources, chunks, graph claims, job outcomes, and checkpoint completion commit transactionally. Failures retain prepared output and use backoff; exhausted jobs require explicit retry. A session preparation checkpoint preserves generated synthesis even before context preparation has finished.

## Content, activity, and context

The shared Readability/semantic-root extractor produces typed blocks and section locators. The parser owns chunking; browser finalization consumes those chunks directly. A useful HTML candidate can repair weak supplied text. The Chrome collector bounds the complete encoded capture, including escaped HTML and references, and marks reductions as partial/truncated. Extraction quality and provenance distinguish live DOM, tab metadata, and explicitly fetched public pages.

Each managed capture links its requesting activity to an immutable, indexed content version. Session/date/goal queries use that version; generic queries use the newest capture, so a late older upload cannot overwrite current content. Returning unchanged content restores existing vectors without another model request. Completed receipts retain input hashes and compact diagnostics while releasing duplicate raw payloads.

Unchanged content reuses cached parsing and analysis. Reuse verifies the indexed source hash; observations retain their own event IDs. Images are opt-in. Browser parsing suppresses the parser's extra text contextualization so the browser's structured page analysis supplies the summary/topics/category.

Activity records become searchable independently of session closure. Navigation reconstruction follows each collector/browser-instance/tab trail, including interleaved tabs, opener relationships, and repeated visits. Attention intervals refer to the navigation that started them, including SPA routes sharing a document ID. Historical backfill remains labelled separately and cannot fabricate tab navigation.

Sessions are deterministic reductions of ordered raw events, bounded by inactivity, browser-instance changes, explicit boundaries, and event count. Late observations recompute derived sessions while preserving immutable activity. Session documents separate observed logs from generated narratives. Threads use explicit goals/corrections first, then tab groups, cached page meaning, and observed trails; optional LLM refinement remains a proposal with confidence and evidence.

## APIs

The host binds to loopback. Registered extension inspection is available at:

| Route                                           | Purpose                                                                                   |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /health`, `GET /connectors`                | Loaded processors and durable protocol capabilities                                       |
| `GET /connectors/browser/policy`                | Current exclusion and session policy                                                      |
| `GET /connectors/browser/status?ids=JOB_ID,...` | Bounded receipt states, attempts, reasons, outcomes, queue age, session retry diagnostics |
| `POST /connectors/browser/retry`                | Retry failed jobs: `{"ids":["JOB_ID"]}`; session IDs use `browser_session:SESSION_ID`     |
| `GET /connectors/browser/library`               | Captured passages, sessions and research threads                                          |
| `POST /connectors/browser/context`              | Correct event context without modifying observations                                      |

Library filters: `query`, `collectorId`, `sessionId`, `threadId`, `goal`, `topic`, `from`, `to`, `domain`, `quality`, `limit` (1–100). Timestamps use milliseconds. Results include URL, passage, heading path, locator, extraction quality and capture origin. Substantive live captures rank above separately fetched evidence. Session/thread filters run before result limits.

Context corrections take `collectorId`, `eventIds` (up to 500), `label`, optional `goal`, and optional `threadId`. Reuse a thread ID to merge assignments; omit it to create a split. Corrections invalidate affected derived preparation and retain raw events.

Other extensions use the typed message bus:

```typescript
const results = await sdk.messages.request(
  "browser:query",
  {
    goal: "Learn SQLite",
    from: Date.now() - 7 * 86400000,
    limit: 20,
  },
  { target: "browser" },
);
```

## Settings and explicit enrichment

Settings are read fresh from disk at admission/job boundaries. Prepared output records the analysis settings used so recovery remains reproducible.

```bash
bun run settings list browser
bun run settings describe browser maxJobsPerRun
bun run settings set browser enableLlmAnalysis true
bun run settings set browser enableImageAnalysis false
bun run settings set browser refineResearchContexts false
```

New limits: `maxPendingJobs`, `maxPendingBytes`, `maxJobsPerRun`, `maxBatchBytes`, `maxJobAttempts`, `maxSessionsPerRun`, `maxSessionEvents`, `collectionWindowMs`, `maxEmbeddingTexts`, and `maxPublicPagesPerRun`. Their defaults/ranges are defined in `settings.help.json`. Existing privacy, session, namespace, and analysis settings remain available. The current repository keeps text analysis disabled and image/context refinement opt-in.

To request public catalog enrichment, enable **both** `browser.allowPublicPageEnrichment` and `web-page-parser.allowFetch`, then submit a record `{ "type":"public_page_capture", "recordId":"enrich-1", "url":"https://example.com/docs" }` in a versioned batch. These jobs have count/time/response/redirect limits, fetch no browser credentials, carry `public-fetch` provenance, never create visits, and use a separate source URI so catalog enrichment cannot overwrite captured DOM. They do not provide authenticated fetching, archive lookup, or PDF/site adapters.

Bookmarks use collector-scoped IDs and real folder ancestry. Newer sequences win over late snapshots; removal updates current membership and retracts current folder claims. Historical evidence is retained unless `retainRemovedCatalogEvidence=false`. History catalog metadata stays separate from rich captures; optional Chrome visit backfill is documented in the extension README.

## Verification

`bun run test:browser` covers durable admission, atomic overload/migration, immutable replay conflicts, phases, bounded embeddings, lease exclusion, preparation/recovery, graph rollback, late sessions, SPA attention, contexts/corrections, catalog lifecycle, extraction, and outbox/import recovery. `browser-relevance.test.ts` establishes a small deterministic baseline with two interleaved goals and a returning goal across sessions.

`bun run test:browser:chrome` runs actual unpacked Chromium against temporary fixtures/database/profile, including service-worker termination and offline/profile recovery. Model endpoints are mocked. `bun run browser:check` verifies generated protocol and content artifacts; `bun run typecheck` checks the repository.

For a local read-only queue view, run `bun run queue:view` and open `http://127.0.0.1:7426`. It reads browser job rows, including failures, without migrating or changing queue state.
