# Model configuration and batches

Chat and embedding profiles are independent. To share a provider connection, declare it explicitly:

```typescript
const sdk = createExtensionSDK("my-extension", {
  namespace: "notes",
  models: {
    connection: { baseUrl: "http://localhost:11434/v1", maxRetries: 0 },
    chat: { model: "qwen2.5:7b", thinkingTokenField: "thinking_budget" },
    embedding: { model: "bge-m3", padToDimensions: 4096 },
  },
});
```

`models.connection` accepts connection options, including injected `client` and `fetchFn`. A shared connection must use `baseUrl`; full endpoints belong to `models.chat` or `models.embedding`. The old positional constructor remains supported, but embedding options no longer configure chat implicitly.

Per-call options override profile defaults. Undefined preserves a default; null disables nullable controls. A per-call base URL replaces the profile endpoint. An injected client supplies its own URL and credentials unless the same call overrides them. Clients are resolved on demand, so environment changes are visible on subsequent requests. Extension settings continue to be read freshly from disk.

Environment fallback uses role-specific settings before shared settings:

| Setting | Chat | Embedding | Shared fallback |
|---|---|---|---|
| Full endpoint | `OPENAI_CHAT_ENDPOINT` | `EMBEDDING_ENDPOINT` | `OPENAI_ENDPOINT` (legacy) |
| Base URL | `OPENAI_CHAT_BASE_URL` | `EMBEDDING_BASE_URL` | `OPENAI_BASE_URL` |
| API key | `OPENAI_CHAT_API_KEY` | `EMBEDDING_API_KEY` | `OPENAI_API_KEY` |
| Model | `OPENAI_CHAT_MODEL` | `OPENAI_EMBEDDING_MODEL`, then `EMBEDDING_MODEL` | `OPENAI_MODEL` for chat |
| Timeout | `CHAT_TIMEOUT_MS`, then `OPENAI_CHAT_TIMEOUT_MS` | `EMBEDDING_TIMEOUT_MS`, then `OPENAI_EMBEDDING_TIMEOUT_MS` | `MODEL_TIMEOUT_MS`, then `OPENAI_TIMEOUT_MS` |

Move a legacy embedding-only `OPENAI_ENDPOINT` to `EMBEDDING_ENDPOINT`. Using an embedding URL for chat, or a chat URL for embeddings, now fails explicitly. Timeout defaults follow the resolved endpoint: 300 seconds for local servers and 60 seconds for cloud servers. `OPENAI_MAX_RETRIES=0` is respected.

Reasoning and thinking controls use `reasoningEffort` and `maxThinkingTokens` internally. Legacy spellings remain accepted at the boundary. The existing defaults are `low` and 512, with environment overrides honored consistently. Set `reasoningEffort: null` and `maxThinkingTokens: null` for providers that do not support these controls. `thinkingTokenField` selects `max_thinking_tokens` (default), `thinking_budget`, or null; Shale sends at most one budget field.

## Shared GPU scheduling

```typescript
await sdk.models.batch(
  async () => {
    // All chat/vision calls, including delegated message handlers, run here.
    const prepared = await prepareDocuments();
    // Save text and metadata to durable checkpoints before returning.
    return prepared;
  },
  async (prepared) => {
    // All embedding calls and commits run here.
    return embedAndCommit(prepared);
  },
);
```

A local batch holds a shared GPU reservation across both phases. Other local requests, including search embeddings, wait. Nested message handlers inherit the reservation and phase. A chat call during embedding, or an embedding call during chat, fails before sending a request. Deferred image processing stays inside its caller's chat phase.

Local endpoints share the `local-gpu` resource by default. `MODEL_GPU_RESOURCE` changes that identity. A profile's `resource` explicitly identifies a GPU behind a LAN or remote URL; null disables resource serialization for that profile. A batch supports one constrained resource. Independent cloud requests can proceed concurrently. Coordination is process-local; separate Shale processes or other GPU clients need external coordination. Await all delegated work before a phase ends.

## Embedding integrity and migration

Embedding responses must contain exactly one finite vector per input, with complete, unique indices and consistent native dimensions. Storage padding is explicit (`padToDimensions`, or `EMBEDDING_DIMENSIONS`, default 4096). Shale rejects truncation. Ingestion validates the index's dimensions and correctly serializes Float32Array views.

The index records the requested model, endpoint, instruction, native dimensions, and storage dimensions. SDK-generated vectors carry this provenance in memory. Serialized or precomputed vectors must supply `embedding_profile` on each chunk; precomputed search vectors use `embeddingProfile`. A model, endpoint, instruction, or dimension change requires reindexing. Plain legacy vectors can still be ingested into untracked indexes, but cannot be mixed into a tracked index.

An existing index with unknown provenance cannot safely accept new model-generated vectors. Rebuild it using the intended embedding configuration:

```bash
bun run scripts/reindex-embeddings.ts production.db
```

This regenerates vectors from stored chunk text without chat calls. It stages vectors in a temporary table, verifies that chunks have not changed, and replaces the index and profile in one transaction. Failed requests retain the previous vectors. Keep ingestion idle while reindexing, and use the same embedding environment/profile when the daemon resumes. The CLI reads embedding configuration from the environment; `reindexEmbeddings(database, options)` also accepts an explicit profile.

`adoptEmbeddingProfile(database, profile)` is available only when the existing vectors' provenance has been independently verified. It cannot change a tracked profile. Reindex if the old index contains fabricated fallback embeddings.

Obsidian now checkpoints prepared notes and images, retains failed embedding work, and advances watermarks only after successful finalization. Recovery surfaces failures so the host keeps the pending work and skips the dependent cron.

## Implementation boundaries

- `lib/ai/config.ts`, `client.ts`, and `options.ts`: connection resolution and option normalization.
- `lib/ai/chat.ts`, `embeddings.ts`, `images.ts`: request construction and response conversion.
- `lib/ai/scheduler.ts`: process-wide GPU reservations and phase checks.
- `lib/embedding-index.ts`, `embedding-profile.ts`: vector storage and provenance.
- `sdk/extension-sdk.ts`, `scope.ts`, `functions.ts`: construction, ambient scope, and convenience functions.
- `lib/ai.ts` and the SDK client classes: compatibility entry points.
