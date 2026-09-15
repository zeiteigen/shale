import { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import defaultDb from "../lib/db-init";
import type { ExtensionManifest } from "../lib/extension";
import { StateManager } from "./state";
import { ContextHydrator } from "./context";
import { CheckpointManager } from "./checkpoint";
import { GraphIngestor } from "./graph";
import { UnifiedIngestor } from "./ingest";
import {
  EmbedderClient,
  getEmbedding,
  getEmbeddings,
  type EmbedderOptions,
} from "./embed";
import {
  LLMClient,
  queryLLM as defaultQueryLLM,
  type LLMOptions,
  type LLMResponse,
  type LLMQueryInput,
  type LLMReasoningEffort,
} from "./llm";
import { ChunkSearcher, extractKeywords } from "./search";
import { SettingsManager } from "./settings";
import {
  Logger,
  createLoggerProxy,
  type LogLevel,
  type LoggerOptions,
  type LoggerProxy,
} from "./logger";
import { ExtensionMessages } from "./messages";
import { MessageBus, defaultMessageBus, createMessageBus } from "../lib/messages";
import type {
  ExtensionStateRecord,
  CheckpointRecord,
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

export * from "./types";
export { StateManager } from "./state";
export { ContextHydrator } from "./context";
export { CheckpointManager } from "./checkpoint";
export { GraphIngestor } from "./graph";
export { UnifiedIngestor } from "./ingest";
export { ExtensionMessages } from "./messages";
export { MessageBus, defaultMessageBus, createMessageBus } from "../lib/messages";
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

export class ShaleSDK {
  readonly state: StateManager;
  readonly context: ContextHydrator;
  readonly checkpoint: CheckpointManager;
  readonly graph: GraphIngestor;
  readonly ingest: UnifiedIngestor;
  readonly embedder: EmbedderClient;
  readonly llm: LLMClient;
  readonly search: ChunkSearcher;
  readonly logger: Logger;
  readonly settings: SettingsManager;
  readonly messages: ExtensionMessages;
  readonly extensionId: string;
  readonly extensionName: string;
  readonly namespace: string;
  readonly database: Database;
  readonly extensionDir?: string;

  constructor(
    extensionId: string,
    namespace?: string,
    database?: Database,
    defaultEmbedderOptions?: EmbedderOptions,
    defaultLLMOptions?: LLMOptions,
    extensionName?: string,
    extensionDir?: string,
    messageBus?: MessageBus,
  ) {
    this.extensionId = extensionId;
    this.extensionName = extensionName || extensionId;
    this.namespace = namespace || extensionId;
    this.database = database ?? defaultDb;
    this.extensionDir = extensionDir;

    this.logger = new Logger(this.extensionName);
    this.messages = new ExtensionMessages(
      this.extensionId,
      messageBus ?? defaultMessageBus,
      this.logger,
    );
    this.settings = new SettingsManager(
      this.extensionDir,
      undefined,
      this.logger,
    );
    this.state = new StateManager(this.extensionId, this.database);
    this.context = new ContextHydrator(this.database);
    this.checkpoint = new CheckpointManager(this.extensionId, this.database);
    this.graph = new GraphIngestor(this.namespace, this.database);
    this.ingest = new UnifiedIngestor(this.namespace, this.database);
    this.embedder = new EmbedderClient(defaultEmbedderOptions);
    this.search = new ChunkSearcher(this.database, this.embedder);

    const sharedLLMOptions: LLMOptions = {
      reasoning_effort: "low",
      max_thinking_tokens: 512,
      ...(defaultEmbedderOptions
        ? {
            apiKey: defaultEmbedderOptions.apiKey,
            baseUrl: defaultEmbedderOptions.baseUrl,
            endpoint: defaultEmbedderOptions.endpoint,
            fetchFn: defaultEmbedderOptions.fetchFn,
            timeoutMs: defaultEmbedderOptions.timeoutMs,
            maxRetries: defaultEmbedderOptions.maxRetries,
            client: defaultEmbedderOptions.client,
          }
        : {}),
      ...defaultLLMOptions,
    };
    this.llm = new LLMClient(sharedLLMOptions);
  }

  /**
   * Generates embeddings for a single text or an array of texts using an OpenAI-compatible endpoint.
   */
  async embed(text: string, options?: EmbedderOptions): Promise<number[]>;
  async embed(texts: string[], options?: EmbedderOptions): Promise<number[][]>;
  async embed(
    input: string | string[],
    options?: EmbedderOptions,
  ): Promise<number[] | number[][]> {
    if (Array.isArray(input)) {
      return this.embedder.embedBatch(input, options);
    }
    return this.embedder.embed(input, options);
  }

  /**
   * Queries an OpenAI-compatible LLM with text prompt and optional images.
   */
  async queryLLM(
    input: string | LLMQueryInput,
    options: LLMOptions & { detailed: true },
  ): Promise<LLMResponse>;
  async queryLLM(
    input: string | LLMQueryInput,
    options?: LLMOptions,
  ): Promise<string>;
  async queryLLM(
    input: string | LLMQueryInput,
    options?: LLMOptions & { detailed?: boolean },
  ): Promise<string | LLMResponse> {
    return this.llm.query(input, options as any);
  }

  /**
   * Saves a temporary checkpoint for crash recovery.
   */
  saveCheckpoint<T = any>(
    data: T,
    optionsOrKey: string | SaveCheckpointOptions = "default",
  ): CheckpointItem<T> {
    return this.checkpoint.save<T>(data, optionsOrKey);
  }

  /**
   * Retrieves queued checkpoints for this extension in FIFO order.
   */
  getCheckpoints<T = any>(): CheckpointItem<T>[] {
    return this.checkpoint.getQueue<T>();
  }

  /**
   * Alias for getCheckpoints().
   */
  getQueuedCheckpoints<T = any>(): CheckpointItem<T>[] {
    return this.checkpoint.getQueue<T>();
  }

  /**
   * Returns context object containing queued checkpoints and recovery helper methods.
   */
  getCheckpointContext<T = any>(): CheckpointContext<T> {
    return this.checkpoint.getContext<T>();
  }

  /**
   * Returns whether this extension has any checkpoints currently queued.
   */
  hasCheckpoints(): boolean {
    return this.checkpoint.hasQueued();
  }

  /**
   * Clears all queued checkpoints for this extension.
   */
  clearCheckpoints(): number {
    return this.checkpoint.clear();
  }

  /**
   * Deletes a checkpoint by ID.
   */
  deleteCheckpoint(id: string): boolean {
    return this.checkpoint.delete(id);
  }
}

/**
 * Creates a scoped Shale SDK instance for an extension.
 *
 * @param extensionId Unique identifier of the extension (scopes state/watermarks)
 * @param namespace Optional namespace for graph entities (defaults to extensionId)
 * @param database Optional SQLite database instance (defaults to production DB)
 * @param defaultEmbedderOptions Optional embedding client configuration
 * @param defaultLLMOptions Optional LLM client configuration
 */
export function createExtensionSDK(
  extensionId: string,
  namespace?: string,
  database?: Database,
  defaultEmbedderOptions?: EmbedderOptions,
  defaultLLMOptions?: LLMOptions,
  extensionName?: string,
  extensionDir?: string,
  messageBus?: MessageBus,
): ShaleSDK {
  return new ShaleSDK(
    extensionId,
    namespace,
    database,
    defaultEmbedderOptions,
    defaultLLMOptions,
    extensionName,
    extensionDir,
    messageBus,
  );
}

// ---------------------------------------------------------------------------
// Ambient Context & Automatic Manifest Discovery
// ---------------------------------------------------------------------------

export interface DiscoveredManifest {
  path: string;
  dir: string;
  manifest: ExtensionManifest;
}

/**
 * AsyncLocalStorage storage for propagating active SDK across asynchronous execution.
 */
export const sdkStorage = new AsyncLocalStorage<ShaleSDK>();

/**
 * Runs an asynchronous or synchronous function within the scope of a specific ShaleSDK instance.
 */
export function runWithSDK<T>(sdk: ShaleSDK, fn: () => T): T {
  return sdkStorage.run(sdk, fn);
}

/**
 * Cache for discovered SDK instances keyed by manifest file path.
 */
const manifestSdkCache = new Map<string, ShaleSDK>();

/**
 * Default fallback SDK instance when outside any extension directory or context.
 */
let defaultSdkInstance: ShaleSDK | null = null;

/**
 * Traverses parent directories upwards from a starting path to find the nearest manifest.json.
 */
export function findNearestManifest(
  startPath: string = process.cwd(),
): DiscoveredManifest | null {
  try {
    let cur = resolve(startPath);
    if (existsSync(cur)) {
      try {
        const stat = Bun.file(cur);
        if (stat.size !== undefined && !cur.endsWith("/")) {
          if (/\.[a-zA-Z0-9]+$/.test(cur)) {
            cur = dirname(cur);
          }
        }
      } catch {}
    }

    while (cur && cur !== dirname(cur)) {
      const candidate = join(cur, "manifest.json");
      if (existsSync(candidate)) {
        try {
          const content = readFileSync(candidate, "utf-8");
          const parsed = JSON.parse(content) as ExtensionManifest;
          if (parsed && typeof parsed === "object" && parsed.name) {
            return {
              path: candidate,
              dir: cur,
              manifest: parsed,
            };
          }
        } catch {}
      }
      cur = dirname(cur);
    }
  } catch {}

  return null;
}

/**
 * Inspects the call stack to determine the directory of the calling file outside the SDK.
 */
export function detectCallerDir(): string | null {
  try {
    const err = new Error();
    const stack = err.stack;
    if (!stack) return null;

    const lines = stack.split("\n");
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(
        /(?:at\s+(?:.*?\s+\()?|^\s*)([/\\][^\s:()]+?)(?::\d+)?(?::\d+)?\)?$/,
      );
      if (match && match[1]) {
        const filePath = match[1];
        if (
          !filePath.includes("/sdk/") &&
          !filePath.endsWith("sdk/index.ts") &&
          !filePath.includes("node:") &&
          !filePath.includes("bun:")
        ) {
          return dirname(filePath);
        }
      }
    }
  } catch {}

  return null;
}

/**
 * Resolves the currently active ShaleSDK instance.
 *
 * Resolution precedence:
 * 1. AsyncLocalStorage (set by host runner e.g. `main` or `runWithSDK`)
 * 2. Lexical/global `shared.sdk` (used during in-memory cron script execution)
 * 3. Nearest `manifest.json` auto-discovered from caller's file location or process entrypoint
 * 4. Default fallback SDK ("default")
 */
export function getSDK(dirOrPath?: string): ShaleSDK {
  // 1. Check AsyncLocalStorage
  const store = sdkStorage.getStore();
  if (store) {
    return store;
  }

  // 2. Check global/lexical `shared.sdk`
  if (
    typeof (globalThis as any).shared !== "undefined" &&
    (globalThis as any).shared?.sdk instanceof ShaleSDK
  ) {
    return (globalThis as any).shared.sdk;
  }

  // 3. Auto-discover manifest.json
  const targetDir =
    dirOrPath ??
    detectCallerDir() ??
    (process.argv[1] ? dirname(process.argv[1]) : undefined) ??
    process.cwd();

  const discovered = findNearestManifest(targetDir);
  if (discovered) {
    const cached = manifestSdkCache.get(discovered.path);
    if (cached) {
      return cached;
    }

    const extId = discovered.manifest.name;
    const ns = discovered.manifest.namespace || extId;
    const sdk = createExtensionSDK(
      extId,
      ns,
      undefined,
      undefined,
      undefined,
      undefined,
      discovered.dir,
    );
    manifestSdkCache.set(discovered.path, sdk);
    return sdk;
  }

  // 4. Default fallback
  if (!defaultSdkInstance) {
    defaultSdkInstance = createExtensionSDK(
      "default",
      "default",
      undefined,
      undefined,
      undefined,
      undefined,
      process.cwd(),
    );
  }
  return defaultSdkInstance;
}

export const getActiveSDK = getSDK;

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
export const checkpoint: CheckpointManager = new Proxy({} as CheckpointManager, {
  get(_target, prop, receiver) {
    const active = getActiveSDK().checkpoint;
    const val = Reflect.get(active, prop, receiver);
    return typeof val === "function" ? val.bind(active) : val;
  },
});

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
export const logger: LoggerProxy = createLoggerProxy(() => getActiveSDK().logger);

/**
 * Dynamic proxy to the active extension's ExtensionMessages.
 * Automatically resolves to the ambient or discovered extension scope.
 */
export const messages: ExtensionMessages = new Proxy({} as ExtensionMessages, {
  get(_target, prop, receiver) {
    const active = getActiveSDK().messages;
    const val = Reflect.get(active, prop, receiver);
    return typeof val === "function" ? val.bind(active) : val;
  },
});

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

export const hasCheckpoints = (): boolean =>
  getActiveSDK().hasCheckpoints();

export const clearCheckpoints = (): number =>
  getActiveSDK().clearCheckpoints();

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
export const info = (...args: any[]): void => getActiveSDK().logger.info(...args);
export const warn = (...args: any[]): void => getActiveSDK().logger.warn(...args);
export const error = (...args: any[]): void => getActiveSDK().logger.error(...args);
export const debug = (...args: any[]): void => getActiveSDK().logger.debug(...args);

// Messaging functions (delegating to active SDK instance)
export const requestMessage = async <TResp = any, TReq = any>(
  channel: any,
  payload: TReq,
  options?: any,
): Promise<TResp> => getActiveSDK().messages.request(channel, payload, options);

export const sendMessage = async <TResp = any, TReq = any>(
  channel: any,
  payload: TReq,
  options?: any,
): Promise<TResp> => getActiveSDK().messages.send(channel, payload, options);

export const publishMessage = async <TPayload = any>(
  channel: any,
  payload: TPayload,
  options?: any,
): Promise<void> => getActiveSDK().messages.publish(channel, payload, options);

export const handleMessage = <TReq = any, TResp = any>(
  channel: any,
  handler: (payload: TReq, context: any) => Promise<TResp> | TResp,
  options?: any,
): (() => void) => getActiveSDK().messages.handle(channel, handler, options);

export const onMessage = <TPayload = any>(
  channel: any,
  listener: (payload: TPayload, context: any) => Promise<void> | void,
  options?: any,
): (() => void) => getActiveSDK().messages.on(channel, listener, options);

export default ShaleSDK;

