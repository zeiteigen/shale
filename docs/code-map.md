# Code map

The repository is organized by ownership. Use this map to find the decisive implementation, then follow its imports and tests.

| Area | Entry points and responsibility |
| --- | --- |
| Host | [`main/index.ts`](../main/index.ts): startup, cron execution/recovery, servers and shutdown. [`main/load-extensions.ts`](../main/load-extensions.ts): manifest discovery and hooks. |
| Host control APIs | [`main/web-api.ts`](../main/web-api.ts), `settings-api.ts`, `auth-api.ts`, `access-api.ts`, `web-tasks.ts`, `web-logs.ts`: generic settings, accounts, profiles, jobs and output. |
| Ingestion boundary | [`main/ingest-http.ts`](../main/ingest-http.ts), `ingest-admission.ts`, `ingest-router.ts`, and [`lib/ingest.types.ts`](../lib/ingest.types.ts): validation, admission and legacy routing. |
| Database initialization | [`lib/db-init.ts`](../lib/db-init.ts), [`lib/database-connection.ts`](../lib/database-connection.ts): path selection, base tables, FTS triggers and connection pragmas. |
| Schema evolution | [`lib/graph/schema.ts`](../lib/graph/schema.ts), `story-schema.ts`, `source-revisions.ts`, `edge-projection.ts`, plus `lib/memory/schema.ts`, `lib/knowledge/schema.ts`, `lib/access/schema.ts`. |
| SDK composition | [`sdk/index.ts`](../sdk/index.ts), [`sdk/extension-sdk.ts`](../sdk/extension-sdk.ts), `scope.ts`, `storage.ts`: public exports, factories and ambient scope. |
| Source ingestion/memory | [`sdk/ingest.ts`](../sdk/ingest.ts), [`sdk/memory/store.ts`](../sdk/memory/store.ts), [`lib/memory/prepare.ts`](../lib/memory/prepare.ts): identity, freshness, selected passages, budgets and projection. |
| Search | [`sdk/search.ts`](../sdk/search.ts), [`sdk/memory/search.ts`](../sdk/memory/search.ts), [`sdk/graph/retrieval.ts`](../sdk/graph/retrieval.ts): BM25, source grouping and graph expansion. |
| Graph APIs | [`sdk/graph.ts`](../sdk/graph.ts) composes `sdk/graph/`: entities, claims, evidence, lifecycle, events, relation definitions, inference and traversal. [`SourceGraph`](../sdk/graph/source.ts) projects connector observations with provenance. |
| Identity and stories | [`sdk/graph/identity.ts`](../sdk/graph/identity.ts), `registry.ts`, `episodes.ts`; [`lib/graph/ontology.ts`](../lib/graph/ontology.ts), `identity-keys.ts`, `retirements.ts`: identity families, keys, registry, merges, episodes and historical retirement. |
| Audited edits | [`sdk/knowledge/changes.ts`](../sdk/knowledge/changes.ts) and the rest of `sdk/knowledge/`: validated operations, version tracking, preview/apply, source archives and receipts. |
| Permissions | [`sdk/access.ts`](../sdk/access.ts) and `lib/access/`: policy, tokens, classification, visibility sets, scoped SQL, write guard and receipt redaction. |
| Model requests | [`sdk/llm.ts`](../sdk/llm.ts), `models.ts`, `model-batch-store.ts`, and `lib/ai/`: configuration, scheduling, transports, bounded maps, batches and cancellation. |
| Messaging | [`sdk/messages.ts`](../sdk/messages.ts) and `lib/messages/`: typed channel contracts, request routing, handler selection and events. |
| Shared chat | [`sdk/chat/`](../sdk/chat/): private raw-message store, windows, admission policy, summaries, checkpoint commits and refresh. |
| Extensions | [`extensions/`](../extensions/): each folder owns its manifest, settings, collection/processing logic and optional Chrome/account/install hooks. See [extension catalog](extensions.md). |
| MCP | [`mcp/http-handler.ts`](../mcp/http-handler.ts), `server.ts`, `access.ts`, `tools.ts`, `edit-tools.ts`, `tools/`, `resources.ts`, `prompts.ts`: transports, scoped sessions and agent contracts. |
| Web backend | [`visualizer/server.ts`](../visualizer/server.ts), `knowledge-api.ts`, `graph-data.ts`, `graph-edges.ts`: retained-memory readers, graph snapshots, inspection/correction endpoints. |
| Web frontend | [`visualizer/src/App.tsx`](../visualizer/src/App.tsx): pages. `Notebook.tsx`, `NodeReader.tsx`, `EpisodesPanel.tsx`, `use-live-graph.ts`: exploration and source/story readers. Graph layout has worker/session modules in the same folder. |
| Chrome runtime | [`scripts/browser-chrome-extension/`](../scripts/browser-chrome-extension/): core listeners, delivery, outbox, jobs and popup shell. `modules/` is committed generated output from [`build-browser-modules.ts`](../scripts/build-browser-modules.ts). |
| Operations | [`scripts/`](../scripts/): settings CLI, migrations/repairs, graph audit/evaluation, focused extraction and snapshot worker. Inspect a script before running it: some mutate the live database. |
| Tests | [`tests/`](../tests/): Bun suites, temporary database/host fixtures, fake Chrome runtime, sidecar fixtures and opt-in real Chromium tests. [`tests/setup.ts`](../tests/setup.ts) isolates ambient database/configuration. |
| Configuration | [`resources/`](../resources/): version-controlled host settings/schema, access-policy defaults/examples and dated reports. Extension settings live with each extension. |
| Private runtime data | `data/` (gitignored): database, secrets, backups, logs, imports and installed sidecars. Do not use it as a test fixture or commit its contents. |

## Change routing

- A new connector usually needs an extension manifest, settings/schema/types, collection/parsing, source projection, recovery, and tests. Use shared toolkits before adding another copy of windowing or delivery logic.
- A new table needs idempotent setup and an existing-database migration. Decide whether restricted consumers may read it; then add a row filter or deliberately leave it denied.
- A new agent mutation needs a schema/implementation, audited editor integration, referenced IDs in `WRITE_REFERENCES`, and scoped-read/write tests.
- A browser behavior change belongs in an extension's `chrome/` source. Rebuild and commit generated modules; never edit generated bundles as the source of truth.
- A host/account UI change should preserve generic provider rendering. Add service-specific behavior to the provider, rather than `main/` or React conditionals.
- A retrieval change must preserve citation identities, output bounds, claim statuses, and filtered FTS joins. Test both unrestricted and restricted profiles.
