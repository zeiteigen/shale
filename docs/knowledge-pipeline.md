# From observations to connected knowledge

The pipeline is asynchronous. A connector receipt, searchable memory, a source digest, and an assigned episode are separate milestones. A successful health check does not mean the extraction backlog is finished or every source is connected.

## 1. Observe and admit

Connectors assign stable logical identities to input and keep enough private state to resume interrupted work. Browser captures have durable admission/processing receipts; service connectors keep cursors and message IDs; file connectors keep fingerprints and discovery watermarks. Repeated observation should update the same logical source rather than create duplicates.

Collection has connector-specific limits. Discord samples and polls within request/message/time budgets. Email reads IMAP folders with UIDVALIDITY-aware cursors and durable gaps. YouTube requires actual playback before creating a source and unique played coverage before caption enrichment. Consult [the connector catalog](extensions.md) for each ownership boundary.

## 2. Prepare and retain source memory

Prepared input becomes a summary and bounded snippets through [`prepareSourceMemory`](../lib/memory/prepare.ts) and the shared memory writer. Model preparation precedes database commit. Checkpoints retain compact prepared output; successful commit atomically writes memory, graph observations, progress and checkpoint resolution where the connector requires it.

The current source revision describes retained memory; original-source fingerprints determine whether an observation really changed. Agent refinement is preserved on identical recapture. Refresh is explicit and may return unavailable if raw history was evicted or the original cannot be reopened. Long-term evidence can only quote retained passages, not discarded original text.

## 3. Digest and extract grounded assertions

[`extensions/knowledge-extractor/index.ts`](../extensions/knowledge-extractor/index.ts) selects active, unfinished source revisions in bounded runs. It gives preference to conversations, mail, notes and pages, with newer sources first within priority bands; browsing activity/session records are skipped in favor of their underlying sources. The default cron is every ten minutes, without a startup run.

The extractor reads retained passages in bounded windows using `source-window.ts`. Its prompt includes source metadata, connector participant information, known registry entities and nearby open episodes through `digest-context.ts`. The first window produces the source-level digest; later windows add entity signals. A digest is the model's reading of retained input, not proof that it reviewed an omitted full original.

`query-extraction.ts`, `parse.ts`, evidence validation and temporal validation reject ungrounded/malformed output. Assertions become **proposed** claims/events with model/method and revision evidence. `claim-datatype.ts` normalizes entity-object relationships separately from literal values. A model cannot promote the user into another person's conversation when connector evidence establishes absence.

[`commitExtractions`](../extensions/knowledge-extractor/commit.ts) writes graph records, digest state, cursor advancement and checkpoint resolution in one immediate transaction. Model output is checkpointed first, so a failed write can be recovered without repeating the call. Later windows reopen episode assignment when they reveal connecting entities.

## 4. Resolve identities across connectors

[`IdentityResolver`](../sdk/graph/identity.ts) uses type families, explicit external IDs, normalized identity keys and registry candidates. Strong compatible keys can merge automatically. Names/acronyms alone or weak/corroborating keys are queued for adjudication. A visited page can refer to an organization or artifact without sharing its identity. Community/server affiliation is distinct from merging the server into the organization.

The [`identity-resolver`](../extensions/knowledge-graph/resolve.ts) cron builds registry rows in small batches, keys connector entities, combines configured/connected user accounts into the `self` Person, queues duplicate candidates, and asks the model about bounded groups. Decisions and identity merges are durable. Merges preserve old IDs and audit records; ordinary discovery follows the canonical identity.

The registry helps the next extraction recognize a known organization even when a source uses an acronym. This feedback loop connects newer digests to older identities. The former BM25 source-pair linker remains available but is disabled by default; it is not the main identity/episode pipeline.

## 5. Assign and consolidate episodes

[`extensions/episodes/assign.ts`](../extensions/episodes/assign.ts) records canonical entity/context signals for each digest. Candidate episodes share those signals; rare entities carry more weight than platforms or the user's identity that occur everywhere. Recency and the digest's suggested episode contribute to the score.

Clear matches attach directly, an intermediate band asks the model, and a new pursuit starts only when the user participated/authored and the digest reported an activity. Observer sources need stronger evidence and can supply context. Unmatched context can be reconsidered when a later source establishes a nearby pursuit; explicit detachment marks the source as unassigned without immediate automatic reassignment.

Assignment uses `PART_OF_EPISODE` and `INVOLVES` claims, with decision confidence/status and per-source step/role. [`consolidate.ts`](../extensions/episodes/consolidate.ts) runs nightly: it identifies dormant pursuits, reviews possible split stories, merges sufficiently confident duplicates, and rewrites changed narrative metadata from current members. A membership/input change during a model rewrite causes that output to be discarded.

Merging combines identity groups for reads; it does not copy membership/involvement rows. Undo separates them again. A detached or removed source can remain a narrative input until the title and summary are completely replaced. That provenance stays protected by access rules even while the corrected membership is already visible locally.

The rewrite replaces the canonical narrative's inputs. Original merged-away narratives keep their provenance for safe undo, so the group's restricted visibility can remain conservative after correction. Closed/empty episodes do not enter the automatic rewrite pass; inspect these cases explicitly instead of assuming the next nightly job releases their inputs.

## 6. Retrieve and correct

`search_graph` searches retained source memory, returning one preview per source with immutable summary/snippet version IDs. It expands up to three hits by default into graph neighborhoods using accepted links and confident proposed links, and returns relevant episodes. Set `maxSeeds:0` to disable neighborhood expansion. `list_episodes`, `get_episode`, and `entity_timeline` provide story/entity entry points without requiring a passage match.

Reads use the consumer's scoped SDK. Profiles filter sources, retained revisions, entities, claims, evidence and narratives. Agents can review claims, fix identities, edit retained memory, refresh originals, or correct episodes through audited tools. Proposed/model-generated context should retain its uncertainty when an agent uses it in an answer.

## Diagnosing a missing connection

| Milestone | Inspect | Interpretation |
| --- | --- | --- |
| Collected | Connector status, receipts, raw job/cursor state | Input may still be deferred, excluded, incomplete or pending indexing. |
| Searchable | Source ID, active revision, `sdk.memory.get`, source preview | Retained memory may omit the specific detail; request refresh if the owner can recover it. |
| Digested | `graph_source_digests`, extraction checkpoints/cursors/rejections | An extraction backlog, invalid output or failed commit can stop progress here. |
| Identified | Source/entity associations, canonical chain, registry keys, resolution queue | Same names are not proof of identity; check actual identifiers and adjudication. |
| Assigned | Digest episode state, active membership claims, candidate signals | It may be context without sufficient pursuit evidence, explicitly detached, or awaiting review. |
| Summarized | Episode update/consolidation timestamps and provenance | Narrative can lag corrected membership, particularly after detach or unmerge. |
| Visible to consumer | Profile rules, current classification and all episode inputs | Restricted retrieval can legitimately omit a source/story that the local UI shows. |

[`scripts/graph-eval.ts`](../scripts/graph-eval.ts) measures cross-source connections against configured example threads; it does not establish comprehensive coverage. [`scripts/audit-graph.ts`](../scripts/audit-graph.ts) checks integrity/provenance. Both differ from a health endpoint or cron-success indicator. [Development](development.md) documents safe invocation and mutation boundaries.
