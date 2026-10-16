# Retained source memory

Shale keeps a summary and selected snippets for each logical source. It processes original contents transiently during ingestion and explicit refresh; the database cannot reconstruct omitted details. Small sources can naturally fit in one exact excerpt.

This describes the long-term searchable memory contract. Connector-private operational tables can retain bounded raw messages/captions for collection, recovery and refresh; they are hidden from scoped consumers. See [architecture](architecture.md), [the data model](data-model.md), and [connector behavior](extensions.md) for the surrounding system.

## Storage contract

| Record | Stored information |
| --- | --- |
| `source_memories` | Current memory version, original-source fingerprint, summary passage reference, generation method, coverage, availability |
| `source_snippets` | Stable snippet ID, current immutable passage reference, purpose, retirement state |
| `graph_revision_passages` / `graph_memory_texts` | Immutable retained passage versions, exact deduplicated text, excerpt/derived/summary kind, original locator |
| `source_revision_fingerprints` | Original observation identity independent of memory revision hashes |
| `source_observations` | Latest 32 observation timestamps, fingerprints, origin, availability, capture quality/provenance |
| `source_entities` | Explicit source ownership; shared concepts do not own every source mentioning them |
| `source_memory_changes` | Actor, reason, expected-version result and optional idempotency receipt, without full source bodies |
| `source_memory_discarded` | Fingerprint, size and reason for unavailable historical passages |
| `chunks` / `chunks_fts` | Current compatibility search projection: summary at index 0, snippets at indices 1 onward |

`graph_revision_chunks` is a compatibility view over retained passages, not a full-source archive. Legacy revision IDs remain usable. Folded browser version sources retain their original IDs/hashes in revision metadata.

Defaults are enforced by the shared writer in `lib/memory/types.ts`: summary at most 8,000 characters; at most 16 active snippets, each at most 1,200 characters and together at most 12,000; at most 32,000 distinct retained text characters per source including cited history. Uncited old passages are removed, retaining the current and most recent previous memory when budget allows. Cited history is immutable. If it fills the allowance, expansion fails atomically and requires explicit evidence compaction; withdrawing a citation does not erase its historical text automatically.

The automatic fallback creates an extractive overview across paragraphs, headings and bounded sections throughout the source. It reports its method and coverage instead of claiming an exhaustive model synthesis. Connector-generated summaries can supplement it. Agents can improve the summary independently of excerpts.

## Agent workflow

1. `search_graph` returns one preview per matching source, with `summaryVersionId` or `snippetVersionId`. Ranking is plain BM25 by default; the knowledge-graph setting `searchRanker: "engine"` (or `ranker: "engine"`) switches to the ranking engine in `sdk/retrieval/`, which keeps the same hit shape, cites its best passage, and adds `similar` (collapsed near-duplicate source ids), `matched`, and on request `explain` (see the [knowledge-graph README](../extensions/knowledge-graph/README.md#search-ranking)). Default limit is five sources. Activity/history/session records and metadata-quality browser captures require explicit type/source filters. Graph expansion defaults to three hit seeds, using accepted links and confident proposed links; each claim retains its status. Set `maxSeeds:0` to disable neighborhood expansion. Related episodes accompany matching sources.
2. `get_source_memory` reads the summary and a paginated snippet array. `get_snippet` reads a retained immutable passage version directly. Both declare `completeOriginal:false`.
3. `edit_source_memory` adds, revises or retires snippets and optionally changes the summary. Supply `expectedVersion`, `actor`, `reason`, and an optional `requestId`. Conflicting versions and changed retry payloads fail without partial writes.
4. An exact excerpt must match retained observed text. Its coordinates are derived from that observation. New interpretations use `kind:"derived"`.
5. For an omitted detail, call `refresh_source` with a topic. The owner reopens a configured file/vault or an explicitly enabled public web fetch. Topic selection can add previously omitted excerpts even if original content is unchanged, while preserving agent work within the active budget. Browser authentication may require recapturing the live tab. Reads never trigger refresh.

Passive recapture of identical original content preserves agent refinements. File fingerprints hash original bytes and browser fingerprints hash observed text; model output and memory edits are separate from source freshness. A changed original makes supported claims stale. Missing/configuration-excluded originals return unavailable; a login-page public fetch cannot replace known richer live memory.

Responses default to a 16,000-character JSON budget, with an explicit maximum of 64,000. Pagination reflects the actual returned page. Oversized graph expansion reports omitted counts and yields space to source hits. These are character limits, not tokenizer measurements.

## Connector retention and recovery

Browser pages use one canonical logical source. History/bookmarks keep metadata and references, and sessions keep narratives and visit references. Raw event JSON is operational data, excluded from ordinary knowledge search. Completed browser jobs/caches retain receipts. Pending raw captures, prepared sessions/cache entries and Chrome outbox captures expire after 24 hours; reacquisition is explicit after expiry. The worker/status sweeps enforce host retention, and outbox reads enforce client expiry. Typed activity records have a 90-day retention window.

Discord uses a separate rolling raw archive bounded by age, payload size and per-conversation count; accepted windows become retained memories. YouTube keeps multipart captions and intermediate synthesis privately while producing bounded summaries/snippets. Shared chat refresh uses exact message membership and reports unavailable/incomplete when missing messages cannot be restored. These private stores do not make complete original history available to MCP.

Notes, documents and images compact preparations before checkpointing. Source-linker work queues store source/revision references and pin only retained passages temporarily. Checkpoints and audits do not provide a hidden full-body archive. Source archives/restores preserve selected memory, snippet identity, locators and associations.

## Offline migration

Stop all database writers and take a consistent rollback backup first. Rehearse on a copy:

```sh
bun scripts/migrate-source-memory.ts --database /tmp/shale-copy.db --apply --compact --report /tmp/shale-report.json
```

The migration is one atomic transaction. Failure rolls back content conversion; restarting retries the transaction. Its marker makes completed conversion idempotent. It preserves graph/evidence IDs, regrounds bounded exact quotation spans, converts structured observation citations to source-level evidence, and explicitly marks unavailable broad citations and affected supported claims for review. Original-source bodies, redundant browser version sources, raw preparations, old checkpoints and raw audit snapshots are removed. FTS rebuild and `VACUUM` reclaim space.

The report records before/after character counts, page bytes, and citation outcomes. `source_memory_discarded` and evidence locators identify individual gaps. Compare evidence counts, foreign keys, integrity, per-source history budgets, original quotation spans, search responses and live daemon health before ending the rollback window.

`db-backup.maxAgeDays` defaults to seven days, including when count retention is unlimited. A cutover rollback backup using the configured filename prefix follows this expiry policy. Old full-content backups must not be retained perpetually. Reload the installed unpacked Chrome extension to activate its updated client expiry behavior.

Dreaming, usage analytics, and autonomous revisit scheduling remain future work in [the roadmap](roadmap.md). This release provides the shared edit/refresh contracts they will use.

## Production cutover, 2026-10-11

The running instance was stopped, backed up, migrated, compacted and restarted. SQLite integrity and foreign-key checks pass. All 28,180 existing evidence records and 21,106 claims survived conversion; 148 redundant browser version sources were folded into canonical pages. The initial cutover produced 2,165 source memories. Normal collection resumed afterward.

| Measurement | Before | After |
| --- | ---: | ---: |
| Current plus historical stored text | 23,273,875 characters | 6,648,842 characters (71.4% reduction) |
| Compacted database pages | 115,286,016 bytes | 75,784,192 bytes (34.3% reduction) |
| Three-source `CareerPortal` MCP response | 833,781 characters | 2,563 characters (99.7% reduction) |
| Three-source `Shale` MCP response | 98,291 characters | 2,404 characters |

11,252 historical evidence records were regrounded into retained excerpts or structured source-level observations. 8,401 broad historical citations now explicitly report unavailable text; many concern obsolete location/content claims, which were retracted. The stale-claim inventory increased from 2,642 to 3,825. Exact retained quotations validate against retained passages. The largest distinct retained-text history was 26,991 characters, below the 32,000-character cap.

The aggregate migration report is [resources/source-memory-migration-report.json](../resources/source-memory-migration-report.json). The rollback snapshot is `data/backups/production-backup-2026-10-11-source-memory-rollback.db`, eligible for age pruning seven days after creation. Temporary full-content audit/rehearsal databases were removed. Ordinary backups now have both count and age retention.

Validation: the full isolated suite passed 543 tests, with three opt-in browser tests checked separately where applicable; web UI regressions and the real unpacked Chrome integration passed. The additional MCP transport regression verifies memory read, immutable snippet lookup, edit/replay/conflict behavior and unavailable refresh. Typecheck and generated browser build checks pass. The screenshot's polar-coordinate tag remains attached to exactly one accepted note claim; the unrelated rows were a fixed React reconciliation bug.
