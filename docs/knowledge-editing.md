# Knowledge editing through MCP

The MCP editing surface adds 32 tools to the existing graph tools. Mutations share validation with `sdk.knowledge`, record an actor and a meaningful reason, and preserve provenance. Read tools return IDs and versions needed for precise edits. Candidate tools suggest leads for review; they never automatically create connections or merge entities.

## Editing tools

| Tool | Purpose |
| --- | --- |
| `update_entity` | Change an entity's primary name or type. |
| `remove_entity_alias` | Remove one alias in its scope. |
| `split_entity` | Create separate identities and explicitly move selected aliases, claims, and chunk links. |
| `connect_entities` | Create an entity-to-entity connection, optionally with evidence and dependencies. |
| `revise_connection` | Replace a connection with a revised claim while retaining history. |
| `retract_connection` | Retract a connection while retaining its provenance. |
| `revise_claim` | Create a replacement for an immutable claim. |
| `unlink_claims` | Remove a supports, contradicts, or supersedes link. |
| `add_claim_dependency` | Add a dependency on another claim. |
| `remove_claim_dependency` | Remove one dependency. |
| `batch_review_claims` | Review multiple claim statuses atomically. |
| `revise_evidence` | Correct a citation, quote, stance, locator, or extraction metadata. |
| `retract_evidence` | Retract active evidence while retaining its history. |
| `revise_event` | Correct event details and optionally replace its participants. |
| `append_graph` | Append entities and claims atomically using local references. |
| `add_source` | Add a text source and its initial chunked revision. |
| `update_source` | Change source metadata, title, or URI. |
| `remove_source` | Archive a source and optionally block reingestion. |
| `restore_source` | Restore an archived source and optionally unblock reingestion. |
| `add_chunk` | Append a verbatim or synthetic chunk and graph links. |
| `revise_chunk` | Correct chunk text, type, or entity and claim links. |
| `remove_chunk` | Remove a current chunk while retaining historical revisions. |
| `list_entities` | Find entities with pagination and optional name, type, and namespace filters. |
| `list_connections` | Inspect an entity's incoming, outgoing, or all connections. |
| `get_source_revision` | Read an immutable historical revision and its archived content. |
| `find_connection_candidates` | Discover possible connections from evidence and optional vector similarity. |
| `find_duplicate_entities` | Discover possible duplicate identities for review. |
| `list_sources` | Find live, removed, or all sources using metadata filters. |
| `inspect_source` | Inspect source lifecycle state, versions, and reingestion block. |
| `list_chunks` | Inspect current or archived chunks with pagination. |
| `preview_graph_changes` | Validate and simulate a batch without committing it. |
| `apply_graph_changes` | Apply an ordered batch atomically and return its audited results. |

## IDs, concurrency, and audit context

Use numeric entity and chunk IDs, string source IDs, string claim and evidence IDs, and numeric revision IDs returned by read tools. Name-based entity references can be ambiguous; resolve names and use exact IDs for edits. Source IDs and revision IDs identify different records: a citation should identify the particular revision and chunk containing its quoted text.

Every individual mutation accepts `actor`, `reason`, and optional `requestId`. The default actor is `mcp-agent`; a descriptive actor identifies the caller in history. A nonempty reason explains why the change is justified. Batch context is supplied once at the top level.

Where supported, supply `expectedVersion` from the current record. Chunk edits can also supply `expectedSourceVersion`. A mismatch rejects a stale edit: reread the record, reassess the proposed change, and submit the updated payload. Preview does not reserve IDs or versions, so another edit can invalidate a preview before application.

Use a stable `requestId` when a transport failure makes the outcome uncertain. An exact retry with the same request ID and payload must not duplicate the committed change. A different edit needs a new request ID; do not reuse an ID after changing operations, actor, or reason. Capture returned change IDs for audit inspection through `graph://changes/{id}` or `sdk.knowledge.history(changeId)`; `graph://changes` and `history()` list recent changes. Individual audit records contain parsed operations and results.

## Tool contracts

The [shared schemas](../sdk/knowledge/schemas.ts) define all input fields, types, defaults, and bounds. MCP `tools/list` exposes those schemas directly. The table below summarizes tool-specific arguments and results. Every mutation also accepts the audit context above and returns the common change envelope described below.

| Tool | Main arguments | Operation result or read response |
| --- | --- | --- |
| `list_entities` | `name`, `type`, `namespace`, `limit`, `offset` | Entities with IDs and versions; total and pagination. |
| `update_entity` | `id`, `name` and/or `type`, `expectedVersion` | Updated entity and version. |
| `remove_entity_alias` | `id`, `name`, `scope`, `expectedVersion` | Entity inspection after alias removal. |
| `split_entity` | `id`, destination `entities` with `ref`, `aliasesToMove`, `claimIds`, `chunkIds` | New identities and explicit reassignment results. Unassigned records remain on the original. |
| `list_connections` | `entity`, `direction`, `predicates`, `statuses`, `context`, pagination | Connections, canonical endpoints, evidence, and `hasMore`. |
| `connect_entities` | `subject`, `predicate`, `object`, optional claim fields | New claim. Literal values use the existing claim creation tool. |
| `revise_connection` | `claimId`, `patch`, `expectedVersion` | Replacement claim and `previousClaimId`. |
| `retract_connection` | `claimId`, `expectedVersion` | Retracted claim. |
| `revise_claim` | `claimId`, `patch`, `expectedVersion` | Replacement claim and `previousClaimId`. |
| `unlink_claims` | `from`, `to`, `relation`, `expectedVersion` of `from` | Removal result and target claim; removing supersession does not reactivate old claims. |
| `add_claim_dependency` | `claimId`, `dependsOn`, `expectedVersion` | Claim inspection with dependencies. Cycles and invalid parent statuses are rejected. |
| `remove_claim_dependency` | `claimId`, `dependsOn`, `expectedVersion` | Claim inspection; conclusion becomes stale. |
| `batch_review_claims` | `claims[]` with `claimId`, `status`, optional `expectedVersion` | Reviewed claims, committed together. |
| `revise_evidence` | `evidenceId`, `patch`, `expectedVersion` | Old and replacement evidence IDs, claim, review notice. |
| `retract_evidence` | `evidenceId`, `expectedVersion` | Withdrawn evidence ID, claim, review notice. |
| `get_source_revision` | `revisionId` | Immutable revision metadata and archived chunks. |
| `revise_event` | `id`, optional name/kind/context/dates/participants, `expectedVersion` | Updated event and participant claims. Supplying participants replaces the complete list. |
| `find_connection_candidates` | `entity`, `namespace`, `limit`, `useVector` | Ranked candidates, signals, supporting claim/chunk IDs, truncation flag. |
| `find_duplicate_entities` | Optional `entity`, `namespace`, `limit` | Candidate pairs, entities, matching identity signals, scan limits. |
| `append_graph` | `entities[]` with `ref`, `claims[]` using IDs or `@ref` | Created entities and claims; local references resolve within the batch. |
| `preview_graph_changes` | `operations[]`, audit context | Simulated change envelope; no writes or real embeddings. |
| `apply_graph_changes` | Same payload as preview | Committed change envelope. |
| `list_sources` | Title/URI/origin/type/namespace filters, `status`, pagination | Live/removed sources, metadata, versions, removal context, total. |
| `inspect_source` | `sourceId` | Source, metadata, lifecycle, related entities/evidence, revision references, exclusions, counts. |
| `add_source` | `title`, `uri`, `text`; optional `id`, type/origin/namespace/metadata/chunkSize | Source ID, backing entity ID, chunk IDs, version. |
| `update_source` | `sourceId`, title/URI/metadata, `expectedVersion` | Source ID, version, review notice. Supplied metadata replaces editable metadata; namespace is preserved. |
| `remove_source` | `sourceId`, `blockReingestion`, `expectedVersion` | Removed/blocked flags, version, review notice. |
| `restore_source` | `sourceId`, `unblockReingestion`, `expectedVersion` | Restored chunk IDs, old-to-new chunk ID map, version. |
| `list_chunks` | `sourceId`, `archived`, pagination | Chunks with text, types, versions, entity links and evidence; source version and total. |
| `add_chunk` | `sourceId`, `text`, `chunkType`, `entityIds`, `claimIds`, source `expectedVersion` | Chunk ID/version, source version, review notice. |
| `revise_chunk` | `sourceId`, `chunkId`, text/type/link changes, `expectedVersion`, `expectedSourceVersion` | Chunk and source versions. Supplied association lists replace existing associations. |
| `remove_chunk` | `sourceId`, `chunkId`, `expectedVersion`, `expectedSourceVersion` | Removed chunk ID, chunk/source versions, review notice. |

The common mutation envelope contains `changeId`, `preview`, ordered `operations` with arguments, before/after snapshots and results, `entityRefs`, `affectedRecords` with versions, `affectedClaimCount`, and `requiresReview` claim IDs. Operation-specific notices may identify additional review needs. Existing mutation tools preserve their previous result shape and add `auditChangeId`, affected records, and review IDs.

Omitted patch fields inherit existing values. Nullable patch fields can be cleared explicitly; JSON `value: null` is a literal value. Mutations reject empty patches. Inputs are bounded to 200 batch operations and 5 MB per batch, with smaller per-field limits in the schemas. Read results expose pagination or truncation; source inspection caps individual record lists at 200.

### Errors

Handler errors retain readable text and expose `structuredContent.error` with `code`, `message`, and `retryable`. Codes include `NOT_FOUND`, `AMBIGUOUS_REFERENCE`, `VERSION_CONFLICT`, `REQUEST_ID_CONFLICT`, `IDENTITY_CONFLICT`, `SOURCE_EXCLUDED`, `EMBEDDING_ERROR`, `VALIDATION_ERROR`, `DATABASE_ERROR`, and `INTERNAL_ERROR`. MCP rejects malformed schema inputs before handler execution. For version conflicts, reread and reassess the edit before resubmitting; retrying the stale payload cannot resolve the conflict.

## Evidence and source lifecycle

Claims and connections remain inspectable after revision or retraction. Evidence points to a historical source revision; later text corrections must not silently rewrite the passage cited by an older claim. Inspect `get_claim_evidence` and `get_source_revision` together to verify the exact text supporting a claim. `revise_evidence` and `retract_evidence` explicitly correct citation state.

`remove_source` archives a source and removes its current content from normal retrieval while retaining historical revisions for evidence. Set `blockReingestion: true` when an extension should not automatically ingest that source again. `restore_source` restores archived content; set `unblockReingestion: true` if automatic ingestion should resume. The archive and reingestion block are separate choices.

Chunk corrections produce new current source content while preserving historical revision content. Use the source ID plus chunk ID for chunk operations and inspect both versions before making a concurrent edit.

Source content changes conservatively mark claims supported by that source stale, including claims whose cited chunk was not changed. Review those claims explicitly. Restoration does not automatically accept them. Preview uses simulated vectors, so embedding service availability and actual embedding profile compatibility are checked during application. Embedding failure leaves no committed partial edit.

## Discover, inspect, and connect

Start with `list_entities`, `resolve_entities`, or `search_graph`. Inspect an exact identity and its existing connections before adding another. `find_connection_candidates` ranks possible connections; `find_duplicate_entities` identifies possible identity overlaps. These outputs are suggestions. Review shared evidence, exact source text, and identity details before authorizing any connection, merge, or split.

For a supported relationship, use `connect_entities` with the predicate and source evidence. For an incorrect relationship, use `revise_connection` or `retract_connection`. For claims that depend on earlier claims, use explicit dependencies. Do not infer factual support solely from vector proximity.

## Individual examples

Correct an entity after inspecting its current version:

```json
{
  "id": 42,
  "expectedVersion": 3,
  "name": "Ada Lovelace",
  "actor": "curator",
  "reason": "Correct the primary name using the source biography",
  "requestId": "entity-42-name-001"
}
```

Call `connect_entities` to add an evidence-backed relation:

```json
{
  "subject": 42,
  "predicate": "WORKS_FOR",
  "object": 87,
  "status": "proposed",
  "evidence": [{"sourceId": "bio-ada", "revisionId": 15, "chunkIndex": 0, "quote": "Ada joined Example Labs.", "stance": "supports"}],
  "actor": "curator",
  "reason": "The biography explicitly names the employer"
}
```

Call `revise_chunk` to correct a current chunk:

```json
{
  "sourceId": "bio-ada",
  "chunkId": 120,
  "expectedVersion": 2,
  "expectedSourceVersion": 4,
  "text": "Ada joined Example Labs in 2024.",
  "actor": "curator",
  "reason": "Correct a transcription error against the original document"
}
```

Call `remove_source` for unwanted ingested content:

```json
{
  "sourceId": "spam-page",
  "expectedVersion": 1,
  "blockReingestion": true,
  "actor": "curator",
  "reason": "The page contains unsolicited advertising"
}
```

After inspecting its new version, call `restore_source` with `sourceId`, `expectedVersion`, `unblockReingestion`, `actor`, and a reason when the archival decision needs reversal.

## Ordered batches and local references

Both batch tools accept the same payload. Each operation has exactly `{ "type": "tool_name", "args": { ... } }`. Operations execute in order within one atomic change. Keep batches bounded and related to one reviewable purpose; a failing operation must leave no partial committed edit.

`append_graph` gives new entities a batch-local `ref`. Use `@ref` in claim entity references to connect these identities without guessing allocated numeric IDs. The local name is scoped to the batch, and preview IDs must not be treated as reserved IDs.

```json
{
  "actor": "curator",
  "reason": "Add a project and its documented owner",
  "requestId": "project-owner-001",
  "operations": [
    {
      "type": "append_graph",
      "args": {
        "entities": [
          {"ref": "project", "name": "Atlas", "type": "Project"},
          {"ref": "owner", "name": "Ada", "type": "Person"}
        ],
        "claims": [
          {"subject": "@owner", "predicate": "OWNS", "object": "@project", "status": "proposed"}
        ]
      }
    }
  ]
}
```

Send this payload first to `preview_graph_changes`. Inspect its effects and errors, then apply the authorized payload through `apply_graph_changes`. After application, inspect returned IDs and affected records. For an uncertain response, retry the exact batch with its original request ID.

## Editing prompts

The server provides `discover-evidence-connect`, `refine-graph`, `remove-spam-edit-chunks`, and `preview-apply-graph-changes`. They guide inspection, evidence review, concurrency handling, and audited edits. They do not turn candidate suggestions into automatic actions.

## Compatibility and verification

- Existing creation, search, merge/undo, review, relation, and event tools retain their response shapes. Audited object responses add fields without replacing existing IDs, including the merge ID used by undo.
- Entity and claim creation expose shared SDK fields for namespace, stable identity, provenance, citations, qualifiers, validity, and dependencies where applicable.
- Claim linking supports `supports`, `contradicts`, and `supersedes`. Use `add_claim_dependency` for derivation dependencies; `derived_from` is not a claim-link relation.
- Search limits and score filters are enforced by the SDK. Read and mutation annotations identify tool behavior.

Verification commands:

```sh
bun run typecheck
bun run test:mcp
bun test
```

`tests/knowledge-editing.test.ts` covers all 32 tool registrations and the SDK editing workflows: rollback, previews, retries, concurrent writes, entity splits, dependency review, exact historical citations, event projections, source lifecycle, exclusions in connector commits, and chunk vector/full-text consistency. `tests/mcp-errors.test.ts` covers error categories. `tests/mcp-server.test.ts` exercises the HTTP MCP surface and existing graph tools. The complete suite also covers SDK and connector regressions. Chrome and web UI end-to-end tests remain opt-in through their existing package scripts.
