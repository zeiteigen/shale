import type { StateManager } from "./state";
import type { ContextHydrator } from "./context";
import type { CheckpointManager } from "./checkpoint";
import type { GraphIngestor } from "./graph";
import type { UnifiedIngestor } from "./ingest";
import type { EmbedderOptions } from "./embed";
import type { LLMOptions, LLMResponse, LLMQueryInput } from "./llm";
import type { ChunkSearcher } from "./search";
import type { SettingsManager } from "./settings";
import { createLoggerProxy, type LoggerProxy } from "./logger";
import type {
  ExtensionStateRecord,
  CheckpointItem,
  CheckpointContext,
  SaveCheckpointOptions,
  HydratedChunk,
  HydratedContext,
  IngestGraphOptions,
  IngestGraphResult,
  IngestSourceAndChunksInput,
  IngestSourceAndChunksResult,
  ChunkSearchResult,
  HybridSearchOptions,
  VectorSearchOptions,
  BM25SearchOptions,
  UnifiedSearchOptions,
} from "./types";
import { getActiveSDK } from "./scope";

// ---------------------------------------------------------------------------
// Convenience Proxies for Scoped Submodules
// ---------------------------------------------------------------------------

/**
 * Dynamic proxy to the active extension's SettingsManager.
 * Automatically resolves to the ambient or discovered extension scope.
 */
export const settings: SettingsManager = new Proxy({} as SettingsManager, {
  get(_target, prop, receiver) {
    const active = getActiveSDK().settings;
    const val = Reflect.get(active, prop, receiver);
    return typeof val === "function" ? val.bind(active) : val;
  },
});

/**
 * Dynamic proxy to the active extension's StateManager.
 * Automatically resolves to the ambient or discovered extension scope.
 */
export const state: StateManager = new Proxy({} as StateManager, {
  get(_target, prop, receiver) {
    const active = getActiveSDK().state;
    const val = Reflect.get(active, prop, receiver);
    return typeof val === "function" ? val.bind(active) : val;
  },
});

/**
 * Dynamic proxy to the active extension's ContextHydrator.
 * Automatically resolves to the ambient or discovered extension scope.
 */
export const context: ContextHydrator = new Proxy({} as ContextHydrator, {
  get(_target, prop, receiver) {
    const active = getActiveSDK().context;
    const val = Reflect.get(active, prop, receiver);
    return typeof val === "function" ? val.bind(active) : val;
  },
});

/**
 * Dynamic proxy to the active extension's CheckpointManager.
 * Automatically resolves to the ambient or discovered extension scope.
 */
export const checkpoint: CheckpointManager = new Proxy(
  {} as CheckpointManager,
  {
    get(_target, prop, receiver) {
      const active = getActiveSDK().checkpoint;
      const val = Reflect.get(active, prop, receiver);
      return typeof val === "function" ? val.bind(active) : val;
    },
  },
);

/**
 * Dynamic proxy to the active extension's GraphIngestor.
 * Automatically resolves to the ambient or discovered extension scope.
 */
export const graph: GraphIngestor = new Proxy({} as GraphIngestor, {
  get(_target, prop, receiver) {
    const active = getActiveSDK().graph;
    const val = Reflect.get(active, prop, receiver);
    return typeof val === "function" ? val.bind(active) : val;
  },
});

/**
 * Dynamic proxy to the active extension's UnifiedIngestor.
 * Automatically resolves to the ambient or discovered extension scope.
 */
export const ingest: UnifiedIngestor = new Proxy({} as UnifiedIngestor, {
  get(_target, prop, receiver) {
    const active = getActiveSDK().ingest;
    const val = Reflect.get(active, prop, receiver);
    return typeof val === "function" ? val.bind(active) : val;
  },
});

/**
 * Dynamic proxy to the active extension's ChunkSearcher.
 * Automatically resolves to the ambient or discovered extension scope.
 */
export const search: ChunkSearcher = new Proxy({} as ChunkSearcher, {
  get(_target, prop, receiver) {
    const active = getActiveSDK().search;
    const val = Reflect.get(active, prop, receiver);
    return typeof val === "function" ? val.bind(active) : val;
  },
});

/**
 * Dynamic proxy to the active extension's Logger.
 * Automatically resolves to the ambient or discovered extension scope and prepends the extension name.
 */
export const logger: LoggerProxy = createLoggerProxy(
  () => getActiveSDK().logger,
);

// ---------------------------------------------------------------------------
// Individual Convenience Functions
// ---------------------------------------------------------------------------

// Settings functions
export const getSettings = <T = Record<string, any>>(): T =>
  getActiveSDK().settings.getAll<T>();

export const getSetting = <T = any>(key: string, defaultValue?: T): T =>
  getActiveSDK().settings.get<T>(key, defaultValue);

// State functions
export const getWatermark = (key: string = "watermark"): string | null =>
  getActiveSDK().state.getWatermark(key);

export const setWatermark = (
  value: string,
  key: string = "watermark",
): void => {
  getActiveSDK().state.setWatermark(value, key);
};

export const getState = (key: string): string | null =>
  getActiveSDK().state.get(key);

export const setState = (key: string, value: string): void => {
  getActiveSDK().state.set(key, value);
};

export const deleteState = (key: string): boolean =>
  getActiveSDK().state.delete(key);

export const getStateJson = <T = unknown>(key: string): T | null =>
  getActiveSDK().state.getJson<T>(key);

export const setStateJson = <T = unknown>(key: string, value: T): void => {
  getActiveSDK().state.setJson<T>(key, value);
};

export const getAllState = (): ExtensionStateRecord[] =>
  getActiveSDK().state.getAll();

// Context functions
export const hydrateContext = (
  sourceIdOrUri: string,
  limit: number = 20,
): HydratedContext => getActiveSDK().context.hydrate(sourceIdOrUri, limit);

export const getRecentChunks = (
  sourceIdOrUri: string,
  limit: number = 20,
): HydratedChunk[] =>
  getActiveSDK().context.getRecentChunks(sourceIdOrUri, limit);

// Checkpoint functions
export const saveCheckpoint = <T = any>(
  data: T,
  optionsOrKey: string | SaveCheckpointOptions = "default",
): CheckpointItem<T> => getActiveSDK().saveCheckpoint(data, optionsOrKey);

export const getCheckpoints = <T = any>(): CheckpointItem<T>[] =>
  getActiveSDK().getCheckpoints<T>();

export const getQueuedCheckpoints = <T = any>(): CheckpointItem<T>[] =>
  getActiveSDK().getQueuedCheckpoints<T>();

export const getCheckpointContext = <T = any>(): CheckpointContext<T> =>
  getActiveSDK().getCheckpointContext<T>();

export const hasCheckpoints = (): boolean => getActiveSDK().hasCheckpoints();

export const clearCheckpoints = (): number => getActiveSDK().clearCheckpoints();

export const deleteCheckpoint = (id: string): boolean =>
  getActiveSDK().deleteCheckpoint(id);

// Graph functions
export const ingestGraph = (options: IngestGraphOptions): IngestGraphResult =>
  getActiveSDK().graph.ingest(options);

// Ingest functions
export const ingestSourceAndChunks = (
  input: IngestSourceAndChunksInput,
): IngestSourceAndChunksResult => getActiveSDK().ingest.sourceAndChunks(input);

// Search functions
export const searchChunks = (
  options: UnifiedSearchOptions,
): Promise<ChunkSearchResult[]> => getActiveSDK().search.query(options);

export const searchHybrid = (
  options: HybridSearchOptions,
): Promise<ChunkSearchResult[]> => getActiveSDK().search.hybrid(options);

export const searchVector = (
  options: VectorSearchOptions,
): Promise<ChunkSearchResult[]> => getActiveSDK().search.vector(options);

export const searchBM25 = (
  options: BM25SearchOptions,
): Promise<ChunkSearchResult[]> => getActiveSDK().search.bm25(options);

// Embed functions (delegating to active SDK instance)
export async function embed(
  input: string,
  options?: EmbedderOptions,
): Promise<number[]>;
export async function embed(
  input: string[],
  options?: EmbedderOptions,
): Promise<number[][]>;
export async function embed(
  input: string | string[],
  options?: EmbedderOptions,
): Promise<number[] | number[][]> {
  return getActiveSDK().embed(input as any, options);
}

// LLM query function (delegating to active SDK instance)
export async function queryLLM(
  input: string | LLMQueryInput,
  options: LLMOptions & { detailed: true },
): Promise<LLMResponse>;
export async function queryLLM(
  input: string | LLMQueryInput,
  options?: LLMOptions,
): Promise<string>;
export async function queryLLM(
  input: string | LLMQueryInput,
  options?: LLMOptions & { detailed?: boolean },
): Promise<string | LLMResponse> {
  return getActiveSDK().queryLLM(input, options as any);
}

// Logger functions (delegating to active SDK instance)
export const log = (...args: any[]): void => getActiveSDK().logger.log(...args);
export const info = (...args: any[]): void =>
  getActiveSDK().logger.info(...args);
export const warn = (...args: any[]): void =>
  getActiveSDK().logger.warn(...args);
export const error = (...args: any[]): void =>
  getActiveSDK().logger.error(...args);
export const debug = (...args: any[]): void =>
  getActiveSDK().logger.debug(...args);

export {
  messages,
  requestMessage,
  sendMessage,
  publishMessage,
  handleMessage,
  onMessage,
} from "./message-functions";
