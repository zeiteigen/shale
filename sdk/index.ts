export * from "./types";
export { StateManager } from "./state";
export { ContextHydrator } from "./context";
export { CheckpointManager } from "./checkpoint";
export { GraphIngestor } from "./graph";
export { SourceGraph, graphIdentity } from "./graph/source";
export { commitPreparedClaims, type PreparedSourceClaim } from './graph/prepared';
export type * from "./graph/types";
export type { GraphSearchOptions, GraphSearchResult } from "./graph/retrieval";
export { UnifiedIngestor } from "./ingest";
export { ExtensionMessages } from "./messages";
export {
  MessageBus,
  defaultMessageBus,
  createMessageBus,
} from "../lib/messages";
export { EmbedderClient, getEmbedding, getEmbeddings, type EmbedderOptions } from "./embed";
export { ModelBatches } from "./models";
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
export { readRootSettings, getRootSetting, getRootSettingsPath } from "../lib/settings";
export type { RootSettings } from "../lib/settings.types";
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
