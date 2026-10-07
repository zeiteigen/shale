import type { ModelRole } from "./config";
import { resolveChatEndpoint, resolveEmbeddingEndpoint } from "./config";
import type { AIClientOptions, LLMOptions } from "./types";
import { getRootSetting } from "../settings";

function positiveInteger(value: number | string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

/** Resolve per call so environment updates never become sticky client defaults. */
export function resolveConcurrency(role: ModelRole, value?: number): number {
  return positiveInteger(value ?? (role === "chat"
    ? getRootSetting("OPENAI_CHAT_CONCURRENCY") : getRootSetting("EMBEDDING_CONCURRENCY")),
  role === "chat" ? 4 : 1, `${role} concurrency`);
}

export function resolveEmbeddingBatchSize(value?: number): number {
  return positiveInteger(value ?? getRootSetting("EMBEDDING_BATCH_SIZE"), 64, "Embedding batch size");
}

export function resolveEmbeddingBatchChars(value?: number): number {
  return positiveInteger(value ?? getRootSetting("EMBEDDING_BATCH_MAX_CHARS"), 16_384, "Embedding batch character budget");
}

export function resolveChatBatchWidth(options?: LLMOptions): number {
  return resolveBatchMode("chat", options) === "api"
    ? positiveInteger(options?.batchSize ?? getRootSetting("OPENAI_CHAT_BATCH_SIZE"), 32, "Chat batch size")
    : resolveConcurrency("chat", options?.concurrency);
}

export function resolveBatchMode(role: ModelRole, options?: AIClientOptions): "concurrent" | "api" {
  const mode = options?.batchMode ?? (role === "chat"
    ? getRootSetting("OPENAI_CHAT_BATCH_MODE") : getRootSetting("EMBEDDING_BATCH_MODE")) ?? "concurrent";
  if (mode !== "concurrent" && mode !== "api") throw new Error(`${role} batch mode must be concurrent or api`);
  return mode;
}

export function resolveBatchEndpoint(role: ModelRole, options?: AIClientOptions): string {
  const hasConnection = options?.baseUrl !== undefined || options?.endpoint !== undefined || options?.client !== undefined;
  const configured = options?.batchEndpoint ?? (!hasConnection ? (role === "chat"
    ? getRootSetting("OPENAI_CHAT_BATCH_ENDPOINT") : getRootSetting("EMBEDDING_BATCH_ENDPOINT")) : undefined);
  const url = new URL(configured ?? (role === "chat" ? resolveChatEndpoint(options) : resolveEmbeddingEndpoint(options)));
  if (!configured) url.pathname = url.pathname.replace(/\/(chat\/completions|embeddings)\/?$/, "/batches");
  const path = url.pathname.replace(/\/$/, "");
  if (!["http:", "https:"].includes(url.protocol) ||
      !(path.endsWith("/batches") || (role === "chat" && path.endsWith("/chat/completions/batch"))))
    throw new Error("Batch endpoints must be HTTP(S) URLs ending in /batches or, for chat, /chat/completions/batch");
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString();
}

export function resolveBatchTimeout(options?: AIClientOptions): number {
  return positiveInteger(options?.batchTimeoutMs ?? getRootSetting("MODEL_BATCH_TIMEOUT_MS"), 86_460_000, "Batch timeout");
}

export function resolveBatchPollInterval(options?: AIClientOptions): number {
  return positiveInteger(options?.batchPollIntervalMs ?? getRootSetting("MODEL_BATCH_POLL_INTERVAL_MS"), 1000, "Batch poll interval");
}
