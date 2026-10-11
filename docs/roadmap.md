# Shale roadmap

Updated 2026-10-11. Retained memory is implemented; dreaming and its usage analytics are future capabilities.

## Implemented foundation: summary and snippet memory

Shale stores a summary and a curated, evolving array of snippets for each source. Original contents are processed transiently during ingestion or explicit reaccess; source fingerprints and provenance are retained alongside selected memory.

Summaries provide broad coverage. Snippets preserve the details useful for answering questions and grounding claims. Agents and normal ingestion can add, revise, replace, and retire snippets after initial collection through one versioned memory API. Per-source budgets and bounded history prevent refinement from gradually becoming full-content retention again.

The memory schema, edit/refresh contracts, connector changes, bounded MCP retrieval, optional graph expansion, evidence migration, and database compaction are implemented. Exact cited excerpts keep immutable identities; discarded details have explicit availability states. See [the source memory guide](source-memory.md) for current contracts and limits.

The [implementation plan](plans/content-storage-and-mcp-plan.md) contains the live database/MCP measurements, proposed storage model, migration sequence, and validation criteria.

## Future milestone: dreaming and targeted re-ingestion

Implement a background consolidation process that periodically evaluates older source memories against how Shale is being used and how those sources connect to recent material. The process can request targeted re-ingestion and add or refine relevant snippets. It is deliberately outside the current implementation scope.

### Signals

- Querying and usage: topics being searched, summaries/snippets actually read, explicit citation use, feedback, and repeated questions for which retained memory has weak coverage. Distinguish a result being shown from it being useful.
- Relationships to recent sources: new links, changed topics, accepted claims, or research threads that make an older source relevant in a new way. Treat proposed/model-inferred connections as uncertain signals rather than established facts.
- Memory gaps: obsolete/redundant snippets, a summary with insufficient coverage of an emerging topic, or needed details that were deliberately omitted at initial ingestion.
- Source freshness and availability: last access, known content changes, extraction quality, and access failures. An unchanged source can have stale relevance; an old timestamp alone does not justify re-ingesting it.

Use bounded rolling aggregates and compact topic/context records. Do not keep an unbounded raw query/prompt log. Source, observation, memory, snippet, and version IDs introduced by the current redesign are the stable identities for later usage tracking; the analytics implementation is deferred with dreaming.

### Processing loop

1. **Select:** score older sources for revisit using usage/coverage gaps and new links, and store a small explicit reason and selection context. Prioritize useful opportunities rather than repeatedly refreshing every source on a calendar.
2. **Reaccess:** ask the owning connector to reacquire the source through a typed refresh request. Reuse an available local file/vault or authenticated browser capture; public fetching retains its own provenance. Honor current exclusions and access settings.
3. **Analyze:** examine the original source transiently with the recent queries/topics/links and current memory in context. Identify useful additional excerpts, obsolete selections, and summary changes. Ground observed excerpts in the actual reaccessed text.
4. **Consolidate:** merge duplicate/overlapping candidates, preserve diverse coverage, and add, revise, replace, or retire snippets within the same storage budgets. Update the comprehensive summary when its coverage or facts need revision.
5. **Commit:** atomically record a new memory revision with system attribution and the revisit reason. Bind new excerpts to their observed source fingerprint and preserve cited old snippet versions. Validate the expected memory version so an agent's concurrent edit is not overwritten.
6. **Evaluate:** record compact outcomes, whether selection improved coverage/usefulness, and when to revisit again. Back off failed or unproductive attempts; do not let the process perpetually rediscover its own generated links.

Differentiate source-content changes from selection changes. New snippet interests can produce a new memory revision without a new source fingerprint. Changed source contents create a new observation and may make older claims stale; never relabel new quotations as evidence from the old capture.

If the original source is unavailable, retain existing memory and record the limitation. The system may reorganize retained facts, but it cannot invent an observed snippet for omitted content or assume that a fresh public page reproduces the historical authenticated one.

### Operational requirements

- Budget background work by sources per cycle, model calls/context, network traffic, and CPU; run resumable work without blocking collection or queries.
- Use a durable queue, idempotent receipts, per-source cooldowns, and retry backoff. Revisit requests use the same refresh/ingestion/memory writer as agent actions.
- Read settings dynamically. Provide controls for enabling dreaming, scheduling, model/network budgets, source eligibility, and retention.
- Apply current-memory and total retained-history budgets. Cited snippets count toward the allowance; when they exhaust it, stop automatic expansion and report a need for explicit evidence/claim compaction.
- Keep raw reaccessed contents in expiring staging only. Dreaming adds selected memory, not another permanent full-content cache or revision archive.
- Expose compact inspectable reasons/outcomes: why a source was selected, what memory changed, source-change versus relevance-change, and what failed.
- Prefer validated observed excerpts; mark generated interpretations and uncertain links. Never turn retrieval frequency or a model's earlier assertion into proof of a fact.

### Completion criteria for the future milestone

- An older source linked to new material gains a relevant, grounded snippet through autonomous targeted re-ingestion.
- Repeated querying can reveal a coverage gap and improve snippet selection without retaining complete source contents.
- An unchanged original source can gain better memory; an unavailable or changed original source is handled truthfully.
- Concurrent agent edits, interruptions, retries, budgets, exclusions, and cooldowns work without losing citations or duplicating commits.
- Evaluation shows improved answer grounding or coverage, with measured background cost and bounded storage growth.

Dreaming should be implemented after the summary/snippet model, editing contracts, connector refresh path, and migration have been validated. It is not part of the current storage rewrite.
