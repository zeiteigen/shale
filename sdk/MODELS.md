# Model configuration and batches

Chat and vision requests use an OpenAI-compatible endpoint. Root settings are read fresh for every request; credentials belong in `data/.env`. Explicit request options override SDK model options, which override root settings and environment fallback.

```ts
const sdk = createExtensionSDK("my-extension", {
  models: {
    connection: { baseUrl: "http://localhost:11434/v1" },
    chat: { model: "local-chat-model" },
  },
});
const answer = await sdk.queryLLM("Explain this document");
```

Use `OPENAI_CHAT_MODEL`, `OPENAI_CHAT_ENDPOINT` or `OPENAI_CHAT_BASE_URL` for chat configuration. `OPENAI_BASE_URL` supplies the shared API base. `CHAT_TIMEOUT_MS` overrides the request deadline; defaults are 300 seconds for local endpoints and 60 seconds for cloud endpoints. `OPENAI_MAX_RETRIES=0` disables retries.

## Batches

`OPENAI_CHAT_BATCH_MODE` selects bounded concurrent requests (`concurrent`, the default) or the provider's file-backed batch API (`api`). API mode uses `OPENAI_CHAT_BATCH_ENDPOINT`, the configured polling interval and deadline, and persistent job state so interrupted jobs can be resumed. Request cancellation propagates through model transports.

`OPENAI_CHAT_BATCH_SIZE`, `OPENAI_CHAT_BATCH_MAX_CHARS`, and `OPENAI_CHAT_CONCURRENCY` bound chat workloads. `sdk.queryLLMBatch(inputs, options)` preserves input order. `sdk.models.mapChat(items, work)` batches independent preparation tasks, including delegated processors and checkpoints.

`sdk.models.batch(prepare, finalize)` reserves the configured local GPU while preparing content and committing results. Both callbacks may use chat requests. Extensions checkpoint prepared content and advance watermarks after successful commits. Failed commits remain recoverable.

`sdk.models.run(work)` holds the configured local GPU reservation for a task; nested chat requests and message handlers reuse that reservation.
