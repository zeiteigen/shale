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

Per-call options override profile defaults. Undefined preserves a default; null disables nullable controls. A per-call base URL replaces the profile endpoint. An injected client supplies its own URL and credentials unless the same call overrides them. Clients are resolved on demand, so root settings changes are visible on subsequent requests. Extension settings continue to be read freshly from disk.

Non-secret host configuration lives in the project-root `settings.json`; API
keys stay in `.env`. Keys retain their former environment names. Per-call and
profile options take precedence over host settings. Each root setting overrides
the environment variable of the same canonical name, with built-in defaults for
missing values. Model and batch settings are read fresh from
disk on every request. See `settings.example.json` for a default configuration
and `settings.help.json` for types, limits, and documentation.

Both the standalone settings CLI and the daemon CLI support the `root` target:

```bash
bun run settings list root
bun run settings get root OPENAI_CHAT_MODEL
bun run settings set root OPENAI_CHAT_CONCURRENCY 4
bun run settings set root EMBEDDING_BATCH_ENDPOINT https://embedding.example/v1/batches
bun run settings describe root EMBEDDING_DIMENSIONS
bun run settings reset root OPENAI_CHAT_CONCURRENCY
bun run settings tui root
bun run settings list-targets
```

The daemon uses the same commands without the `bun run` prefix, including root
setting suggestions and tab completion. Root settings are a separate scope from
extension settings; extensions can read them through `getRootSetting` or
`readRootSettings` from `@shale/sdk`. API keys cannot be written through the root
settings tools. Root settings use role-specific keys before shared keys:

| Setting | Chat | Embedding | Shared fallback |
|---|---|---|---|
| Full endpoint | `OPENAI_CHAT_ENDPOINT` | `EMBEDDING_ENDPOINT` | Derived from the base URL |
| Base URL | `OPENAI_CHAT_BASE_URL` | `EMBEDDING_BASE_URL` | `OPENAI_BASE_URL` |
| API key | `OPENAI_CHAT_API_KEY` | `EMBEDDING_API_KEY` | `OPENAI_API_KEY` |
| Model | `OPENAI_CHAT_MODEL` | `OPENAI_EMBEDDING_MODEL` | Built-in role defaults |
| Timeout | `CHAT_TIMEOUT_MS` | `EMBEDDING_TIMEOUT_MS` | `MODEL_TIMEOUT_MS` |

Setting only `OPENAI_BASE_URL` automatically derives `/chat/completions` and `/embeddings`. Role-specific base URLs override that shared base; full endpoints override derivation. A full endpoint set to a bare API base such as `/v1` is rejected before making a request. Removed aliases are ignored when reading older files and dropped when saving settings. Using an embedding URL for chat, or a chat URL for embeddings, fails explicitly. Timeout defaults follow the resolved endpoint: 300 seconds for local servers and 60 seconds for cloud servers. `OPENAI_MAX_RETRIES=0` is respected.

Reasoning and thinking controls use `reasoningEffort` and `maxThinkingTokens` internally. Legacy spellings remain accepted at the boundary. The existing defaults are `low` and 512, with environment overrides honored consistently. Set `reasoningEffort: null` and `maxThinkingTokens: null` for providers that do not support these controls. `thinkingTokenField` selects `max_thinking_tokens` (default), `thinking_budget`, or null; Shale sends at most one budget field.

## Shared GPU scheduling

### Request batching

Batching supports two independent modes for chat and embeddings. `concurrent` is
the default: chat sends bounded concurrent completion requests, while embedding
arrays are split into bounded requests. `api` uses the OpenAI-style asynchronous
[Batch API](https://developers.openai.com/api/docs/guides/batch): JSONL upload,
job submission, polling, and output download. Shale restores input order using
`custom_id` and rejects incomplete, duplicate, failed, or invalid results.

| Setting | Chat | Embedding | Default |
|---|---|---|---|
| Mode | `OPENAI_CHAT_BATCH_MODE` | `EMBEDDING_BATCH_MODE` | `concurrent` |
| Dedicated Batch API endpoint | `OPENAI_CHAT_BATCH_ENDPOINT` | `EMBEDDING_BATCH_ENDPOINT` | `/batches` beside the role's synchronous endpoint |
| Batch size | `OPENAI_CHAT_BATCH_SIZE` | `EMBEDDING_BATCH_SIZE` | 32 chat preparation tasks in API mode; 64 texts per embedding request |
| Synchronous padded character budget | — | `EMBEDDING_BATCH_MAX_CHARS` | 16,384 (longest text times input count) |
| Concurrent synchronous requests | `OPENAI_CHAT_CONCURRENCY` | `EMBEDDING_CONCURRENCY` | 4 chat; 1 embedding |

Synchronous embedding groups obey both the count and character budget, including
instruction prefixes. This keeps many short texts from being padded alongside a
large note. An individual text larger than the budget runs alone and remains
intact; this is a batching limit, not truncation or a model context limit. Such a
text may still need a longer `EMBEDDING_TIMEOUT_MS` on slow hardware. The character
budget does not apply to asynchronous Batch API submissions. SDK clients can
override it with `batchMaxChars`.

Role API keys apply to both transports. The Batch API's Files API is resolved as
`/files` beside its `/batches` endpoint. A batch endpoint must end in `/batches`;
query parameters are preserved. `MODEL_BATCH_TIMEOUT_MS` controls the overall
job deadline (default 86,460,000 ms), and `MODEL_BATCH_POLL_INTERVAL_MS` controls
polling (default 1,000 ms). HTTP timeouts and retries remain separate. A provider
must implement both Batch and Files APIs to use `api` mode. There is no automatic
fallback after submission, which would risk duplicate processing.

```typescript
const sdk = createExtensionSDK("my-extension", {
  models: {
    chat: {
      endpoint: "http://localhost:11434/v1/chat/completions",
      concurrency: 4,
      // Or batchMode: "api", batchEndpoint: "https://chat.example/v1/batches",
      // batchSize: 32, batchTimeoutMs: 86_460_000, batchPollIntervalMs: 1000,
    },
    embedding: {
      endpoint: "http://localhost:11435/v1/embeddings",
      batchSize: 64,
      batchMaxChars: 16384,
      concurrency: 1,
    },
  },
});

const answers = await sdk.queryLLMBatch(["First prompt", "Second prompt"]);
const detailed = await sdk.llm.completeBatch(["Prompt", { prompt: "Describe", images: "diagram.png" }]);
const vectors = await sdk.embed(["First text", "Second text"]);
```

`sdk.models.mapChat(items, async item => prepare(item))` batches independent
extension tasks while retaining their existing prompts, delegated message
handlers, and per-item checkpoints. It is used by Obsidian, browser, directories,
process-image, process-document, knowledge-extractor, and source-linker. Nested
task batches share collection scope; actual synchronous requests obey process-wide
concurrency limits per role and endpoint. Preparation and embedding preserve the
existing two-phase boundaries. Failed tasks stop new scheduling and drain started
work before rejecting. Processors retain their per-file error handling.

In API mode, concurrent compatible requests within a preparation batch are
collected into a JSONL job. Requests with different models, providers, credentials,
signals, or transport settings use separate jobs. Embedding arrays submit their
bounded input groups in one job, up to 50,000 inputs. Empty batches make no calls.
The SDK persists uploaded file and submitted job IDs in extension-scoped SQLite
state. Retrying the same inputs after a timeout or restart resumes the submitted
job rather than submitting another one. Terminal failures clear the job record;
transport interruptions retain it. Low-level clients can supply `batchStore` for
the same recovery behavior. Interrupted requests must be retried with identical
inputs and grouping to resume their job.

Batch providers can take up to 24 hours to finish. Choose extension processing and
message deadlines appropriate to the provider; an aborted message leaves its
submitted job available for recovery. Enabling or disabling API batching on the
same embedding provider preserves embedding provenance. Changing providers still
requires reindexing. Root model settings resolve per call; changing API keys in `.env` requires
restarting the daemon. Database paths and server ports apply on startup.

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

This regenerates vectors from stored chunk text without chat calls. It stages vectors in a temporary table, verifies that chunks have not changed, and replaces the index and profile in one transaction. It also recreates the vector table when the storage size changes. Failed requests or commits retain the previous schema, vectors, and profile. Stop the daemon while reindexing, and use the same embedding environment/profile when it resumes. The CLI reads embedding configuration from root settings with same-name environment fallback; `reindexEmbeddings(database, options)` also accepts an explicit profile. Storage size follows `padToDimensions`, then `EMBEDDING_DIMENSIONS`, then the existing index size; `padToDimensions: null` uses the model's native size.

New databases use the root `EMBEDDING_DIMENSIONS` setting (default 4096). Empty indexes can safely resize on startup; populated indexes retain their dimensions until explicitly reindexed. Database path and server port changes require restarting the daemon; model settings reload on each request.

`adoptEmbeddingProfile(database, profile)` is available only when the existing vectors' provenance has been independently verified. It cannot change a tracked profile. Reindex if the old index contains fabricated fallback embeddings.

Obsidian now checkpoints prepared notes and images, retains failed embedding work, and advances watermarks only after successful finalization. Recovery surfaces failures so the host keeps the pending work and skips the dependent cron.

## Implementation boundaries

- `lib/ai/config.ts`, `client.ts`, and `options.ts`: connection resolution and option normalization.
- `lib/ai/chat.ts`, `embeddings.ts`, `images.ts`: request construction and response conversion.
- `lib/ai/scheduler.ts`: process-wide GPU reservations and phase checks.
- `lib/embedding-index.ts`, `embedding-profile.ts`: vector storage and provenance.
- `sdk/extension-sdk.ts`, `scope.ts`, `functions.ts`: construction, ambient scope, and convenience functions.
- `lib/ai.ts` and the SDK client classes: compatibility entry points.
