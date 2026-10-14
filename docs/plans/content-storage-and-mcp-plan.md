# Summary and snippet memory: storage and MCP redesign

Prepared 2026-10-11 from the active database and live Shale MCP, then implemented as summaries and evolving snippets rather than full-source retention. This document preserves the original audit and design rationale; [the source memory guide](../source-memory.md) describes the shipped schema, contracts, limits and migration procedure. The visualizer connection bug has been fixed. The future dreaming process is tracked in [the roadmap](../roadmap.md).

## Objective

Make Shale useful to agents through small, predictable retrieval responses containing relevant content and resolvable citations. Each source retains a decently comprehensive summary and a curated array of snippets. Full source contents are processed transiently and are not retained in Shale's long-term database, caches, archives, or processing logs.

Snippets can be added, refined, and retired after initial ingestion through agent edits, subsequent ingestion, and later system-driven consolidation. Keep source identity and provenance structured. The eventual dreaming process uses querying/usage and relationships to recent sources to choose older sources for targeted re-ingestion; building that scheduler and analysis process is explicitly deferred.

This is selective, lossy memory. Retained summaries and snippets remain available locally; omitted details require reopening or refetching the original source. A URI is a reference, not a promise that its original contents can always be recovered. The source may have changed, require an authenticated browser, or become unavailable.

## Verified baseline

Inspected `data/production.db` through a read-only SQLite connection and made a consistent SQLite backup at `/tmp/shale-content-audit.db` for aggregate analysis. The local database and live MCP returned exactly the same entity/claim/edge counts and the same text for chunk 17393, confirming that the audit examined the database exposed by the running instance. Integrity check passed; foreign-key check returned zero violations.

Measurements are character counts unless explicitly labeled bytes. They are not tokenizer measurements or promises of equivalent disk savings.

| Measurement | Observed |
| --- | ---: |
| Database pages, including free pages | 115,286,016 bytes, approximately 110 MiB |
| Sources | 2,313 |
| Current chunks | 15,736 |
| Historical revision chunks | 17,285 |
| Entities / claims / edges | 2,187 / 21,106 / 2,089 |
| Current text | 11,329,443 characters |
| Historical text | 11,944,432 characters |
| Unique exact text across current and historical chunks | 10,362,555 characters |
| Avoidable repeated exact text across those stores | 12,911,320 characters, 55.5% of stored text |
| Browser activity sources containing one raw JSON chunk each | 1,447 |
| Current browser duplicate text beyond first occurrence | 3,924 chunks; 1,164,773 characters |
| Page/version chunks shorter than 80 characters | 2,183 of 4,300 |
| Largest current chunk | 142,237 characters, an Obsidian whole-note copy |
| Source-linker pending batch checkpoint | 6,616,963 characters |

The exact-text deduplication calculation measures the old design's overhead. The new design also discards unselected source content; exact-text deduplication alone is no longer the target architecture. Do not merge unrelated source identities because their retained text happens to match.

Live MCP probes:

| Call | Response characters | Result |
| --- | ---: | --- |
| `search_graph({query:"Shale",limit:3})` | 98,291 | First two hits have identical text from current/version sources; graph, evidence, and related passages dominate the response. |
| `search_graph({query:"CareerPortal",limit:3})` | 833,781 | Top hits are a large unrelated browsing session and two copies of a logged-out page. Five neighborhoods, 165 evidence records, 93 related passages. |
| `search_graph({query:"Shale",limit:3,maxSeeds:1,maxDepth:1,maxNeighbors:1})` | 17,129 | Tight graph limits still return full chunks and unrelated passage text. Expansion cannot be disabled through this tool. |

For CareerPortal, the 93 related passages contain only 74 distinct `(revisionId,chunkIndex)` pairs. Their text totals 446,363 characters versus 136,796 after deduplication by passage identity. One 16,293-character Steam page passage is repeated for multiple claims. The requested result limit does not bound response size or relevance.

The logged-out CareerPortal page has 42 characters of extracted body but creates a 405-character synthetic wrapper, two tiny body chunks, a 190-character link listing, and a 774-character metadata JSON chunk. It also has a separate version source with the same content. Its extraction metadata already identifies it as metadata quality, yet ordinary search promotes it.

## Decisive code paths

| Cause | Evidence |
| --- | --- |
| Graph search hydrates every citation's entire passage and repeats passages per claim | `sdk/graph/retrieval.ts:17-35`, especially the map key at line 31 |
| MCP always expands search and serializes the full SDK result | `mcp/tools/search.ts:24-65`; pretty-printing in `mcp/types.ts:40-48` adds overhead but is secondary |
| Current text is copied into immutable revision text | `lib/graph/source-revisions.ts:11-14,34-36,55-59` |
| Browser summary/context, raw body, references, and metadata JSON are all searchable chunks | `extensions/browser/page-ingest.ts:402-458` |
| Browser latest page and version sources both receive the same chunks | `extensions/browser/page-ingest.ts:466-505`; `extensions/browser/content-version.ts` |
| History copies page content into another source and recognizes metadata by text prefixes | `extensions/browser/history-ingest.ts`; `extensions/browser/history-content.ts:33-54` |
| Activity JSON becomes a knowledge source independently of operational storage | `extensions/browser/activity-graph.ts:121-157`; `extensions/browser/activity-store.ts` |
| Sessions serialize entire event records again, then split JSON into prose-sized fragments | `extensions/browser/session-graph.ts:7-20`; `extensions/browser/session-ingest.ts:119-133` |
| Web parser creates one chunk per DOM block, even when blocks are tiny | `extensions/web-page-parser/chunk-blocks.ts`; `parser.ts` also builds excerpt-based contextual summaries |
| Obsidian indexes an unbounded whole-note copy alongside section/snippet copies | `extensions/obsidian/chunker.ts:165-224`; large Markdown tables also defeat snippet bounds |
| Location metadata becomes thousands of graph claims | `extensions/obsidian/document-graph.ts:19-31`; database contains 6,319 accepted `CHUNK_LOCATION` claims |
| Citations require exact immutable text and existing indices/offsets | `sdk/graph/evidence.ts:14-39`; `tests/knowledge-editing.test.ts`; `tests/extraction-evidence-match.test.ts` |
| Whole source/pair inventories accumulate in one checkpoint | `extensions/source-linker/process-links.ts:154-178` |

Existing uncommitted work already changes browser identity, activity graph, link filtering, graph edge projection, and visualizer behavior. Integrate those changes; do not replace or revert them. They reduce graph clutter but do not fix chunk storage or MCP expansion.

## Verified visualizer connection bug

The screenshot showing Kiro/TradingView under `polar-coordinates` represents a UI reconciliation bug, not those relationships in the database. SQLite, the live MCP, and the generated map snapshot agree: tag entity 1064 has exactly one `HAS_TAG` connection from note 1061. Neither entity has the unrelated browser relationships shown in that panel.

The Connections list in `visualizer/src/Notebook.tsx` keyed rows by predicate plus neighbor ID. Distinct claims about repeated visits shared those keys; switching to another entity left stale DOM rows behind. An isolated browser regression reproduced Course Home and Kiro rows surviving under the tag. The fix keys each row by its unique claim ID. The regression now passes through repeated selection changes, alongside the existing web/browser checks. This finding does not establish that every database relationship is semantically useful; graph relevance still needs the separate ingestion/retrieval changes in this plan.

## Target memory model

Use logical sources with a current summary and a curated array of snippets. Keep SQLite and FTS5, but replace full-source snapshots with immutable versions of retained memory. A source observation records what was accessed; a memory revision records what Shale chose to remember. Those are different identities.

| Record | Responsibility |
| --- | --- |
| `sources` | Logical source identity, URI, title, origin, namespace, lifecycle, and current memory revision. A browser page has one logical source. |
| `source_observations` | Source fingerprint, capture origin, access time, extraction quality, and availability. Contains no full source body. Retain observations referenced by memory/evidence and a bounded recent inventory. |
| `summary_versions` | A comprehensive synopsis: subject, main points, important relationships, conclusions, and relevant qualifications. Include observation reference, method/model, actor, version, and derivation provenance. |
| `source_snippets` | Stable logical snippet IDs, current version pointers, purpose/topics, and active/retired state. Externally presented as an ordered array. |
| `snippet_versions` | Selected exact excerpts or explicitly labeled derived descriptions, their source fingerprint and locator, origin/method/model, and immutable version IDs. This is where excerpt text is stored once. |
| `memory_revisions` | Summary version plus ordered snippet-version references, reason, actor, and memory hash. Does not copy summary/snippet text. |
| `source_entities` | Explicit source/entity association, replacing the implicit identity bridge through `SOURCE_URI` claims. |
| Structured references and activity | Useful links/assets and browser visit/session/history/bookmark records referencing sources. Apply independent retention/aggregation policies; avoid full collector snapshots as permanent content. |

An external read returns `{source, summary, snippets, freshness, availability}`, subject to the MCP budget. Snippet objects include their stable ID, version, text, role, origin, and usable citation reference. Selection rationales and operational metadata are inspectable without being repeated in every retrieval result.

Prefer exact observed excerpts for textual evidence. A snippet may also be a derived explanation or vision description, but must be labeled as generated and identify its retained support and method. Summaries and derived snippets do not become verbatim evidence merely because an agent can read them. Existing image/OCR method and proposed-status rules remain meaningful.

Store structural location on each snippet: heading path, page/slide/sheet, DOM selector/locator, or original span. A new snippet version preserves the old version when evidence cites it; existing citations never silently follow a mutable snippet pointer. Structured metadata replaces per-chunk `CHUNK_LOCATION` and tab/window bookkeeping claims.

Index current summaries and active snippets, with separately weighted title/heading fields. Search returns matching snippets or relevant summary sections; it does not index historical text, raw events, or processing payloads. Meaningful repeated-source text can share storage, but source identity and provenance remain separate.

### Budgets and retention

Comprehensiveness means coverage of the source's important ideas, not sentence-by-sentence compression. Proposed configurable starting limits are a 2,000–4,000-character summary target with an 8,000-character maximum, up to 16 active snippets, a 1,200-character maximum per snippet, and a 12,000-character total active-snippet budget. Validate these defaults against long notes/documents; substantial sources should use more of the allowance than tiny pages.

Also bound total retained text per source across current and historical memory; proposed starting cap is 32,000 characters. Current memory, older cited excerpts, summary versions, and retained audit text all count. Keep only current and a small recent rollback history by default; retire obsolete uncited text after a configurable window. Compact manifests and metadata do not carry copies of previous content.

Cited snippet versions are pinned while their evidence is retained. Do not silently delete them, or allow them to expand indefinitely outside the storage budget. If pinned evidence exhausts a source's allowance, automatic expansion stops and reports that explicit evidence/claim compaction is required. New candidate snippets compete for space by relevance, coverage, redundancy, and utility; continued refinement is replacement and selection as well as addition.

Hash observed source content transiently for change detection. Hash retained memory separately from the source fingerprint using canonical ordered version references. Tab IDs, timing, settings changes, and summary edits do not falsely signal an external source change. Source-change freshness and memory relevance are separate state: an unchanged source can need better snippets because the questions being asked have changed.

Full extracted text/HTML/documents may exist only in memory or short-lived bounded staging needed for ingestion/retry. Give staging an explicit size limit, expiry, and commit cleanup. Recovery resumes from bounded work/selected-memory checkpoints or reacquires the source. Browser caches, failed-job payloads, archive snapshots, graph mutation audits, logs, and recurring backups must not quietly preserve all raw content. Existing original files/vaults remain external sources, not duplicate Shale storage.

## Ingestion and ongoing refinement

Read the source transiently, generate a source-wide summary, choose diverse useful snippets, validate provenance, and commit retained memory and graph changes atomically. For long sources use bounded section processing and a temporary coverage outline, then synthesize the comprehensive summary and select snippets within the final budget. Process more than an arbitrary first-character prefix, but retain only selected memory.

Choose initial snippets for important definitions, facts, decisions, examples, caveats, and distinctive details. Record what each snippet contributes so selection does not fill the array with near-duplicate quotations. Preserve exact selected code/table rows where useful. A short substantive excerpt is valid; a hard minimum length should not discard it.

An agent can update the summary, add a snippet, revise one, retire one, or propose a source refresh after initial ingestion. Expose narrow typed SDK/MCP operations with expected versions, actor, reason, and optional retry ID. Use immutable snippet versions and atomic memory commits, preserving existing citations. Summary edits and snippet edits are independent; reading a useful snippet never requires the entire synopsis.

Observed excerpts supplied by an agent must be validated against a transiently accessed source or existing retained evidence. Otherwise label the input as an agent assertion/derived note, with explicit provenance, rather than claiming it is a verified quotation. Changed external content produces a new observation; an excerpt from it cannot be attributed to an older fingerprint.

Subsequent passive captures can improve or replace summaries/snippets. Repeated unchanged captures reuse prior analysis unless new selection context justifies refinement. Refine with the original source when available; repeatedly summarizing the existing summary can erase qualifications and compound mistakes. Automatic edits, agent edits, and ingestion all share the same memory writer and concurrency checks.

Honor quality and origin. Known login/loading/error/navigation pages become metadata-only catalog entries, rather than fabricated summaries. Classify using structure and extraction signals, not a broad word blacklist. Real content mentioning login/error remains eligible. Public fetched login pages cannot displace richer memory from an authenticated live capture just because the fetch was newer.

Browser history and bookmarks reference logical pages instead of storing copied bodies. Captures reference observations and memory revisions; A-B-A visits preserve event order without retaining complete A/B snapshots. Keep existing privacy/exclusion and URL identity rules. Attention/activation/close data belongs in typed visit measurements. Sessions reference ordered visits and an optional concise summary, without split event-log JSON.

Obsidian, directories, documents, and images use the same summary/snippet model. Whole notes/documents remain accessible through their external URI when available, rather than reconstructed from a stored full body. Carry heading/page/slide/sheet provenance on selected snippets. Extension coordination uses the typed message bus; browser ingestion does not import another connector's internals.

Knowledge extraction operates on transient source windows during ingestion or explicit reaccess, and on retained snippets for later local work. Claims that require exact textual grounding must pin a retained supporting excerpt within budget. Source-linker compares summaries/snippets and identifies promising source associations; it cannot assume that arbitrary old chunks remain readable. Cache compact selected-memory derivations, and replace the large source-linker pair checkpoint with a durable bounded work queue containing references and small selection context.

The dreaming scheduler, its usage analysis, and automatic selection of old sources for re-ingestion are future work. The current implementation provides the editable memory/provenance/refresh contracts it will call. See [the roadmap](../roadmap.md) for triggers, processing, and safeguards against unbounded growth.

## MCP and retrieval contract

Separate discovery, memory reading/editing, source reaccess, graph exploration, and audit inspection. Use compact valid JSON with readable field names, omit irrelevant empty/default fields, and expose one representation of each piece of text.

Default `search_graph` returns at most five meaningful source-grouped hits: title, URI, relevant summary excerpt or snippet, summary/excerpt/derived origin, a stable citation reference, and relevant freshness/availability. Use a query-centered excerpt up to 600 characters. Prefer exact snippet matches when grounding a specific fact; use the comprehensive summary for source discovery and conceptual questions. Group redundant/current-version hits and cap excerpts per source before applying the final result limit, with bounded candidate oversampling.

Graph expansion is opt-in and returns globally deduplicated entities/claims with snippet references. Fix the existing per-claim passage deduplication bug; multiple claims can reference one snippet without copying its text. Apply global node/claim/evidence/query limits across seeds, and do not hydrate all related evidence bodies automatically.

Provide bounded `get_source_memory`, `get_snippet`, and summary/snippet editing operations. The summary may be comprehensive in storage but need not be emitted in full for each search hit. Existing chunk/source tool names can temporarily adapt to memory records, with explicit availability rather than pretending discarded chunks still exist.

Provide an explicit `refresh_source` request routed to the owning connector. Return a job receipt/progress result and the resulting memory revision. A memory read does not secretly initiate an expensive network fetch. Access local files/vaults through their paths, and browser sources through an available authenticated capture or allowed public fetch. Reaccess is subject to current connector exclusions/settings; a public fetch is not equivalent to the historical authenticated page.

Ordinary reads return retained memory. Omitted full contents are only available from the original source through explicit access; otherwise return `content_not_retained`, `source_unavailable`, or a similarly precise status. Changed-source reaccess identifies a new observation rather than claiming to reproduce the old one. Legacy citation reads may expose only retained ranges and must declare gaps.

Temporal questions use bounded `search_activity`/`list_visits` operations with time filters and pagination, rather than collector JSON inside knowledge search. Session summaries can participate in knowledge discovery, while full timelines require explicit activity reads.

Use `maxChars=16,000` as the default serialized text-response budget and a hard maximum of 64,000 for deliberately expanded requests. Reserve room for the envelope and continuations; return a truncation reason when data is omitted. Never cut JSON arbitrarily. Bound query work before hydration/serialization. These are character limits, not exact tokenizer measurements.

Mutation contracts retain optimistic concurrency, actor/reason attribution, retry idempotency, and auditability. Audit records retain selected edits and version references, not raw source snapshots. Update MCP descriptions/resources/prompts, SDK types, and visualizer clients alongside the API change. Maintain identity aliases until consumers use `source_entities`.

## Migration from the full-content database

Convert existing sources into comprehensive summaries and selected snippets while their old contents are available in a migration snapshot. Use resumable source-sized work units; do not require refetching authenticated history or regenerate every analysis unnecessarily. Migrate raw source bytes out of the production database, caches, archives, failed-job payloads, and old full-text revision tables after conversion and verification.

This supersedes the earlier plan to preserve every historical chunk byte indefinitely. Preserve exact retained evidence, not full revision bodies. Build a citation migration report before compaction:

- Explicit quotation/span evidence becomes an exact retained excerpt with its original source hash, locator/coordinates, and legacy citation mapping. Combine overlapping retained evidence windows without changing what the quotation states.
- Source-level citations keep observation identity/provenance and explicitly indicate whether text was retained.
- Whole-chunk citations without a quote/span require bounded re-grounding from the original text. If a valid narrow excerpt cannot be established, retain the citation's provenance, mark its evidence as unavailable/needs review, and conservatively downgrade the affected claim. Do not silently replace its evidence with an arbitrary prefix or a generated summary.
- Broad citations or unusually many pinned excerpts that exceed the retained-memory budget are reported for compaction/review. Do not quietly preserve a complete source under the label of snippets.

Retain legacy revision IDs/hashes as compact observation/citation references where needed. Current numeric chunk IDs may map to retained snippet IDs, but discarded chunks explicitly become unavailable. Source removal/restoration archives retained memory, associations, and lifecycle state rather than full text. Restoring a source does not promise recovery of discarded content.

Take a one-time rollback backup before cutover, outside normal serving/indexing, with an explicit expiry after the verified rollback window. Do not leave old full-content tables or perpetual full-source backups as the long-term design. This planning change does not itself delete existing database content or backups.

## Implementation sequence

1. **Bound retrieval immediately.** Add compact summary/snippet-oriented projections, opt-in graph expansion, correct evidence text deduplication, and explicit read budgets. This reduces current MCP costs while the old database still exists.
2. **Build source memory and editing contracts.** Add narrow schema/writer/reader/hash/index modules, summary/snippet versions, observation fingerprints, budgets, explicit source/entity associations, lifecycle, and atomic edits. Design the typed connector refresh request and provenance adapter; defer dream scheduling and usage analysis.
3. **Rewrite ingestion and consumers.** Browser, notes, directories/documents/images process content transiently and commit summaries plus selected snippets. Remove full body/version/history copies and searchable raw logs. Update extraction/linking/visualizer readers, staging/cache expiry, retry recovery, generated browser contracts when needed, and current graph-clutter integration.
4. **Convert and evaluate on a copy.** Produce retained memory for existing sources, migrate quotation evidence, classify ambiguous broad citations, verify memory budgets and completeness, and compare real agent retrieval tasks. Report changed citation availability before discarding old text.
5. **Cut over and compact.** Fresh rollback backup, brief coordinated writer pause/drain, final-delta conversion, schema/code switch, reopened daemon/MCP connections, FTS rebuild, raw-content removal, and verified space reclamation. Resume normal collection under the new retention model.
6. **Later: dreaming.** Implement usage/link-driven relevance analysis and targeted old-source re-ingestion as the separate roadmap milestone. It uses the same selection, editing, provenance, and storage limits; it does not add a parallel unbounded archive.

Prefer files that do one or two things. Preserve dynamic settings reads, cross-extension message decoupling, transactional commits, privacy/exclusions, and recoverable watermarks.

## Validation and completion criteria

- **Summary coverage:** representative long notes/documents receive a synopsis covering their main sections, conclusions, and qualifications. Later-section facts must influence selection; initial-prefix-only summaries fail this check.
- **Selective retention:** after successful commit and staging cleanup, no full source body survives in production content/revision/archive/cache/job/log tables. Large-source storage is governed by memory budgets rather than original source size. Short selected excerpts may naturally contain an entire tiny source.
- **Evolving snippets:** agent and subsequent-ingest updates can add, replace, and retire snippets independently of the summary. Repeated unchanged observations do not create duplicate memory; conflicts and retries behave deterministically.
- **Grounding:** exact retained excerpts validate against the original observation, with Unicode/locator semantics preserved. Generated memory is labeled. Old evidence stays bound to immutable snippet versions, and citation gaps/downgrades are explicit.
- **Bounded history:** current, retired, and cited text counts toward the per-source retained-text budget. Automatic expansion stops when pinned evidence fills it; summaries, manifests, staging, operational events, and work queues cannot accumulate raw contents outside the budget.
- **Recovery:** interrupted ingestion/conversion resumes without lost receipts or duplicate graph commits. Expired staging requires reacquisition or a clear unavailable state. Watermarks advance only after atomic commit.
- **Reaccess:** missing, changed, excluded, authenticated, and public-only sources produce accurate availability/provenance. A refresh cannot silently turn new text into a quotation from an old capture.
- **Retrieval cost:** measured three-hit probes stay within 16,000 serialized characters by default, targeting at least 98% reduction for CareerPortal. No automatic event neighborhoods or repeated evidence text; follow-up reads remain bounded. Report tokenizer costs separately if measured.
- **Integration and storage:** test migration/editing/citation/recovery/selection boundaries, run typecheck and relevant browser build checks, then integration suites and live MCP smoke tests. Use an isolated `SHALE_DB_PATH` for tests. Compare actual compacted database size and retrieval relevance, not just deduplication percentages.
- **Deferred scope:** this release exposes retained-memory and refresh contracts but does not implement the dreaming scheduler, usage analytics, or autonomous old-source revisit policy.

Relevant existing suites include knowledge editing/evidence matching, extraction, graph retrieval seeds, search/MCP, browser durability/outbox, notes/documents, and vision provenance. Rewrite tests that require complete source snapshots, duplicate bodies, or searchable JSON logs around selected-memory fidelity and explicit availability. Add coverage for summary quality/selection and immutable snippet edits instead of preserving the obsolete full-content contract.
