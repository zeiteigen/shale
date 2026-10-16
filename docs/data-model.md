# Data model

SQLite is the durable store. [`lib/db-init.ts`](../lib/db-init.ts) creates base tables; [`ensureGraphSchema`](../lib/graph/schema.ts) adds graph, knowledge-editing, access, memory, and story schemas. Schema changes are additive/idempotent, with explicit column upgrades where `CREATE TABLE IF NOT EXISTS` cannot upgrade an existing table. Tests and scripts can inject a database into the SDK instead of using the ambient connection.

## Sources and retained text

A `sources` row identifies a logical source with a string ID, origin, type, URI, title, timestamps, and current revision hash. ID is the durable reference; URI identifies where it came from; origin identifies the connector/provider; type identifies its semantic record kind. A namespace groups graph entities and claims, not source permissions.

[`sdk/ingest.ts`](../sdk/ingest.ts) admits source updates and retained chunks transactionally, honoring removed-source exclusions and original-content freshness. Current `chunks` and `chunks_fts` are compatibility/search projections of retained memory. Index zero is the summary; following indices are selected snippets. A chunk ID or index alone is not an immutable historical citation.

| Tables | Meaning |
| --- | --- |
| `source_memories`, `source_snippets` | Current versioned summary and snippet selections, stable snippet IDs, generation/availability metadata |
| `graph_source_revisions` | Immutable source revision identities used by evidence |
| `graph_revision_passages`, `graph_memory_texts` | Retained passage versions and deduplicated exact text |
| `graph_revision_chunks` | Compatibility view over retained passages |
| `source_revision_fingerprints`, `source_observations` | Original-content fingerprints and bounded capture observations, separate from memory edits |
| `source_entities`, `chunk_entities` | Source ownership/provenance and current passage/entity associations |
| `graph_source_metadata`, `graph_source_archives` | Source metadata and selected-memory snapshots for removal/restoration |

Memory edits and observation freshness are separate: an agent can improve a summary without pretending the original changed. Evidence can pin cited history; uncited history is compacted within per-source budgets. Exact excerpts must match retained observed text; interpretations are `derived`. [Source memory](source-memory.md) specifies the limits and refresh behavior.

## Entities and identity

`entities` stores integer IDs, stable IDs, namespace, type, displayed name, and optional `canonical_id`. A merge points an old identity to another; it does not delete old IDs or rewrite all evidence. Consumers follow canonical chains and, when looking up relationships, include the members of the identity group. `graph_identity_changes` audits merges and their undo.

`graph_aliases` stores names and scoped identifiers. Scopes distinguish ordinary names, source IDs, connector keys, external account identifiers, search spellings, and normalized `key:*` identity keys. Names alone are ambiguous. Strong identifiers can establish identity within compatible type families; domains and organizations may establish affiliation rather than identity. The rules live in [`identity-keys.ts`](../lib/graph/identity-keys.ts), [`ontology.ts`](../lib/graph/ontology.ts), and [`IdentityResolver`](../sdk/graph/identity.ts).

`entity_registry_fts` indexes canonical registry entities using names, aliases, search keys, descriptions, and episode summaries. It supports model shortlists; it is not the source-memory index. `graph_resolution_queue` records pending mention/candidate adjudications. `graph_entity_retirements` removes unsupported connector identities from ordinary discovery while preserving historical records and external-ID ownership.

## Assertions, evidence, and events

`graph_claims` stores an assertion from a subject to either an entity object or a typed JSON value. It includes predicate, polarity, context/qualifiers, confidence/strength, valid time, recorded time, method/model, and lifecycle status. Claims can disagree; changing a source can make previously supported assertions stale.

`graph_evidence` ties assertions to source revisions, passage positions/locators, quotations, and generation method. Retained evidence availability is explicit when old text has been discarded. Model extraction requires grounded quotes for ordinary claims/events; connector assertions can cite structured observations. `graph_dependencies` and `graph_claim_links` represent derivation and relationships between claims. Reviews/status/evidence history preserve corrections.

`graph_events` describes an event entity; `graph_participants` records roles through claims. Connector conversation windows can produce events, but the user's participation must come from connector evidence rather than a model assuming every conversation belongs to the user.

`edges` is a compatibility projection of graph assertions, not the authoritative mutation surface. Use graph/knowledge APIs so lifecycle, projections, versions, and evidence stay consistent. Current traversal defaults to accepted assertions; search expansion additionally includes confident proposed links and returns their status.

## Digests and episodes

[`lib/graph/story-schema.ts`](../lib/graph/story-schema.ts) defines the story layer:

| Table | Meaning |
| --- | --- |
| `graph_source_digests` | Latest digested revision, source summary, user involvement/activity, resolved entities, dates, model, episode-assignment state |
| `graph_digest_signals` | Canonical entities/context used to connect sources and compute document frequency |
| `graph_episodes` | Metadata for an `Episode` entity: kind, status, summary, dates, step labels and consolidation progress |
| `graph_episode_provenance` | Durable narrative input source IDs; survives detachment, source removal and merge/unmerge |

Membership is a `PART_OF_EPISODE` claim from the source's record entity to an episode. Qualifiers carry `sourceId`, role, step and decision basis. `INVOLVES` claims name the entities that characterize the pursuit. Assignment updates membership, involved entities and digest state together. A source can participate in more than one episode, although automatic assignment normally chooses one candidate at a time.

Episode merge groups identities rather than copying memberships, involvement or metadata. Readers combine dates and relationships across the group. Undo separates those groups; generated narratives are refreshed by consolidation. Detachment retracts membership but retains earlier narrative provenance until a complete replacement title/summary has been committed. Restricted profiles need every active member and retained narrative input visible, including across merge chains. This prevents stale generated text from exposing removed private inputs.

Membership can also come from global clustering (`lib/graph/cluster.ts`, basis `cluster …`); see the [episodes README](../extensions/episodes/README.md#global-clustering-clusteringmode-narrativemode-default-shadow).

Consolidation rewrites canonical open episodes with remaining members. It replaces that row's provenance, preserving merged-away narratives and their inputs for undo. This can conservatively keep a merged group restricted until its original narratives are separately corrected; see [access-control limits](access-control.md#how-it-is-enforced).

## Operational and audit state

`extension_state` is extension-scoped key/value state for cursors, watermarks, batch IDs and leases. `checkpoints` holds durable prepared work for commit/recovery. Connector-specific tables hold receipts, jobs, raw messages/captures and partial synthesis. These are operational stores, not agent knowledge; restricted profiles deny them by default.

`graph_changes` records audited editor operations and results; `graph_record_versions` tracks optimistic concurrency. Source-memory edits have their own versioned receipts. `sdk.knowledge` performs preview/apply, idempotency and access guards inside the transaction. Restricted receipts omit raw before/after snapshots and filter nested records. See [knowledge editing](knowledge-editing.md) and [access control](access-control.md).
