/** Canonical host settings, shared by the daemon and web editor. */
export interface RootSettings {
  OPENAI_BASE_URL?: string;
  OPENAI_CHAT_BASE_URL?: string;
  OPENAI_CHAT_ENDPOINT?: string;
  EMBEDDING_BASE_URL?: string;
  EMBEDDING_ENDPOINT?: string;
  OPENAI_CHAT_MODEL?: string;
  OPENAI_EMBEDDING_MODEL?: string;
  CHAT_TIMEOUT_MS?: number;
  EMBEDDING_TIMEOUT_MS?: number;
  MODEL_TIMEOUT_MS?: number;
  OPENAI_MAX_RETRIES?: number;
  MODEL_GPU_RESOURCE?: string;
  OPENAI_REASONING_EFFORT?: string;
  OPENAI_MAX_THINKING_TOKENS?: number;
  EMBEDDING_DIMENSIONS?: number;
  OPENAI_CHAT_BATCH_MODE?: "concurrent" | "api";
  EMBEDDING_BATCH_MODE?: "concurrent" | "api";
  OPENAI_CHAT_BATCH_ENDPOINT?: string;
  EMBEDDING_BATCH_ENDPOINT?: string;
  OPENAI_CHAT_CONCURRENCY?: number;
  OPENAI_CHAT_BATCH_SIZE?: number;
  EMBEDDING_BATCH_SIZE?: number;
  EMBEDDING_BATCH_MAX_CHARS?: number;
  EMBEDDING_CONCURRENCY?: number;
  MODEL_BATCH_TIMEOUT_MS?: number;
  MODEL_BATCH_POLL_INTERVAL_MS?: number;
  SHALE_DB_PATH?: string;
  PORT?: number;
  SHALE_QUEUE_VIEWER_PORT?: number;
  SHALE_MCP_PORT?: number;
  MCP_PORT?: number;
}
