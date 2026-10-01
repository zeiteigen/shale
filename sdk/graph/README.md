# Knowledge graph SDK

Shale stores independently identifiable entities, claims, events, evidence, and source revisions in its local SQLite database. Each SDK exposes these through `sdk.graph`. Existing `graph.ingest({ entities, edges })` calls continue to work and also produce claims.

## Connector commits

`SourceGraph` binds connector entities, literal properties, relationships, and events to a persisted source revision. Use it inside the same database transaction as `sourceAndChunks` and checkpoint completion. Identities follow namespace, entity type, and a URI or scoped key. Assertion IDs follow source revision and assertion content; retries preserve existing review decisions and refresh live chunk linkage. Accepted observations and proposed interpretations remain distinct. `commitPreparedClaims` consumes portable parser claims whose chunk indexes have been offset to the persisted source.

`SOURCE_URI` properties register a `source-id` alias used by source linking and knowledge extraction to connect their outputs to connector-owned entities. Source changes retain historical evidence and stale the preceding revision's supported assertions.

## Entities and identity

```ts
const alice = sdk.graph.entities.create({
  stableId: "people:alice",
  name: "Alice Smith",
  type: "Person",
  aliases: [{ name: "Alice", scope: "team:atlas" }],
  externalIds: { email: "alice@example.test" },
});
const atlas = sdk.graph.entities.create({ name: "Atlas", type: "Project" });

sdk.graph.entities.rename(alice.id, "Alice Jones"); // Same stable ID.
const candidates = sdk.graph.entities.resolve("Alice", "team:atlas");
```

Labels are not identity proof. `resolve` returns every candidate, collapsing confirmed merges; ambiguity requires an explicit choice. External IDs are scoped by authority. Modern entities store their label in `display_name`; the legacy `name` column remains a unique storage key. Use `entities.get(id)` when displaying labels.

Merge operations redirect identity without rewriting historical claims:

```ts
const mergeId = sdk.graph.entities.merge(duplicate.id, alice.id, "Confirmed identity");
sdk.graph.entities.unmerge(mergeId);
sdk.graph.entities.removeAlias(duplicate.id, "Alice", "team:atlas");
sdk.graph.entities.addAlias(alice.id, "Alice", "team:atlas");
```

## Claims, properties, and evidence

```ts
sdk.graph.relations.define({
  name: "LEADS",
  sourceTypes: ["Person"],
  targetTypes: ["Project"],
  inverse: "LED_BY",
  maxTargets: 1,
});

const claim = sdk.graph.claims.add({
  subject: alice.id,
  predicate: "LEADS",
  object: atlas.id,
  context: "team:atlas",
  validFrom: Date.UTC(2025, 0, 1),
  validTo: Date.UTC(2026, 0, 1),
  method: "manual",
  evidence: [{
    sourceId: "source-atlas",
    chunkIndex: 0,
    quote: "Alice leads Atlas.",
    locator: { start: 0, end: 18 },
  }],
});

sdk.graph.claims.add({
  subject: atlas.id,
  predicate: "LATENCY",
  value: 12.5,
  datatype: "number",
  unit: "ms",
  qualifiers: { environment: "local", percentile: 95 },
});
```

A claim has exactly one entity object or JSON value. Values may include structured records and arrays, with finite numbers. Core scalar datatypes are validated; custom datatype labels are preserved. Confidence describes extraction confidence; strength describes relationship weight. Neither is interpreted as a calibrated probability of truth.

Claims are immutable assertions. Multiple assertions of the same relationship coexist. Supplying a duplicate claim ID throws; change status through review or create a replacement linked with `supersedes`. `ingestClaims` atomically commits a batch.

Evidence can support, contradict, or mention a claim. Text evidence requires a revision chunk; quotes and optional offsets must match the saved text. Locators also support page, timestamp, and image region coordinates. Coordinates identify a location; they do not automatically verify image/audio contents. You may attach evidence to a particular `revisionId` instead of the current `sourceId`.

Source revisions and text snapshots survive replacement/deletion. Ingestion preserves source IDs and creation timestamps. A changed source hash marks supported assertions and their derived dependents stale; a same-hash refresh does not. Existing snapshots are immutable. Source writers must change the hash when content changes and use the ingestion API when replacing chunks.

## Events and participant roles

```ts
const meeting = sdk.graph.events.create({
  name: "Atlas planning meeting",
  kind: "Meeting",
  context: "team:atlas",
  occurredFrom: Date.UTC(2025, 5, 1),
  participants: [
    { entity: alice.id, role: "organizer", position: 0 },
    { entity: atlas.id, role: "project", position: 1 },
  ],
});
```

An event is an entity with an occurrence interval, an `EVENT_KIND` claim, and role assertions. Each occurrence is distinct unless the caller supplies a stable event ID. Participant order is explicit. Each participant may carry evidence, and common event evidence is attached to the event assertion and its role assertions. `events.get(id)` returns the event and participants. `events.list({ kind, context, from, to, statuses, limit, offset })` filters occurrence intervals and the event assertion's review status. Events and their claims commit together.

## Review, conflicts, and lineage

New claims default to `proposed`. Automated extraction always produces proposed claims; the legacy ingestion API defaults to accepted to preserve existing behavior. Legacy imported weights are retained as strength, without invented confidence or provenance.

```ts
sdk.graph.lifecycle.review(claim.id, "accepted", "user", "Checked against the note");
sdk.graph.lifecycle.link(replacement.id, claim.id, "supersedes", "user", "Corrected source");
const inspection = sdk.graph.inspect(claim.id);
const conflicts = sdk.graph.conflicts.find({ entityId: alice.id });
```

Review states include proposed, accepted, disputed, rejected, superseded, retracted, and stale. Every explicit review records actor/reason; status history also captures automatic invalidation. Claim links support `supports`, `contradicts`, and `supersedes`. Superseding marks the older assertion superseded.

Conflict detection identifies explicit contradictions, opposite assertions of the same scoped fact, and competing values for a declared single-valued relationship. It respects context, namespace, qualifiers, units, language, and overlapping validity. It does not treat missing information as false or claim to detect every semantic disagreement.

Derived claims declare `dependsOn`. Inactive/disputed dependencies invalidate downstream conclusions transitively. Accepting a derived claim requires accepted dependencies. The explicit `inference.transitive(predicate, namespace, context, limit)` operation only uses declared transitive relations, accepted positive claims, matching qualifiers, and overlapping time intervals. It records dependencies and does not invent confidence.

## Graph queries and retrieval

```ts
const neighborhood = sdk.graph.query.traverse({
  start: alice.id,
  direction: "both",
  context: "team:atlas",
  at: Date.UTC(2025, 5, 1),
  maxDepth: 2,
  maxNodes: 100,
  maxClaims: 500,
});
const path = sdk.graph.query.path({ start: alice.id, target: atlas.id, maxDepth: 3 });
const search = await sdk.search.graph({ query: "Atlas", mode: "bm25" });
```

Traversal defaults to accepted, positive claims and follows merged identities. It returns shortest discovery paths with claim IDs and a `truncated` flag. Depth, entity, and inspected-claim budgets prevent unlimited traversal. Scalar properties are available through `claims.list` rather than treated as entity links.

`at` filters real-world validity using half-open intervals `[validFrom, validTo)`. `knownAt` filters recorded knowledge and reconstructs claim status at that time. Entity labels and merges are resolved in their current state. `claims.list` supports predicate, entity, namespace, context, status, polarity, limit, and offset filters; each page is capped at 1,000 claims.

Graph search seeds neighborhoods from BM25/vector/hybrid results and entity-to-chunk links. It returns source hits, graph paths, evidence, and related saved passages separately. Accepted claims are used by default; opt into `graph.statuses: ["accepted", "proposed"]` to explore unreviewed output. Expansion is bounded per seed, with at most 20 seeds. Inference and conflict discovery also report truncation when their budgets are reached.

## Extension messaging and migration

The `knowledge-graph` extension provides typed channels: `graph:entity`, `graph:resolve`, `graph:merge`, `graph:unmerge`, `graph:event`, `graph:events`, `graph:ingest-claims`, `graph:claims`, `graph:query`, `graph:inspect`, `graph:review`, `graph:link-entities`, and `search:graph`. Other extensions can use these without importing another extension's implementation.

On the next database initialization, additive migrations preserve existing entities, IDs, namespaces, edges, and edge metadata. Existing topology becomes legacy assertions. `edges` remains a compatibility projection maintained by `graph.ingest`; new query/inspection APIs read claims. Direct legacy SQL edge writes are not rich claim ingestion; use the SDK when adding new graph knowledge.

The visualizer exposes claim/evidence inspection, status timelines, reviews, renaming, reversible merges, context filters, and validity-date filters. Unreviewed/disputed connections are dashed. The map caps claims at 1,000 and reports truncation; inspection caps each entity's displayed claims at 200.
