export * from "./types";
export { StateManager } from "./state";
export { ContextHydrator } from "./context";
export { CheckpointManager } from "./checkpoint";
export { GraphIngestor } from "./graph";
export { UnifiedIngestor } from "./ingest";
export { ExtensionMessages } from "./messages";
export {
  MessageBus,
  defaultMessageBus,
  createMessageBus,
} from "../lib/messages";
export { EmbedderClient, getEmbedding, getEmbeddings } from "./embed";
export {
  LLMClient,
  type LLMOptions,
  type LLMResponse,
  type LLMQueryInput,
  type LLMReasoningEffort,
} from "./llm";
export {
  ChunkSearcher,
  extractKeywords,
  DEFAULT_STOP_WORDS,
  removeStopwords,
  eng,
} from "./search";
export { SettingsManager } from "./settings";
export {
  Logger,
  createLoggerProxy,
  type LogLevel,
  type LoggerOptions,
  type LoggerProxy,
} from "./logger";

export { ShaleSDK, createExtensionSDK, default } from "./extension-sdk";
export * from "./scope";
export * from "./functions";
export type { ExtensionSDKOptions, ModelProfiles } from "./sdk-options";
export { ModelCoordinator, modelCoordinator } from "../lib/ai/scheduler";
export {
  adoptEmbeddingProfile,
  readEmbeddingProfile,
  type EmbeddingProfile,
} from "../lib/embedding-profile";

export type * from "../lib/messages.types";
