import { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import defaultDb from "../lib/db-init";
import type { ExtensionManifest } from "../lib/extension";
import { StateManager } from "./state";
import { ContextHydrator } from "./context";
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
} from "./llm";
import { ChunkSearcher, extractKeywords } from "./search";
import type {
  ExtensionStateRecord,
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
export { GraphIngestor } from "./graph";
export { UnifiedIngestor } from "./ingest";
export { EmbedderClient, getEmbedding, getEmbeddings } from "./embed";
export { LLMClient } from "./llm";
export { ChunkSearcher, extractKeywords } from "./search";

export class ShaleSDK {
  readonly state: StateManager;
  readonly context: ContextHydrator;
  readonly graph: GraphIngestor;
  readonly ingest: UnifiedIngestor;
  readonly embedder: EmbedderClient;
  readonly llm: LLMClient;
  readonly search: ChunkSearcher;
  readonly extensionId: string;
  readonly namespace: string;
  readonly database: Database;

  constructor(
    extensionId: string,
    namespace?: string,
    database?: Database,
    defaultEmbedderOptions?: EmbedderOptions,
    defaultLLMOptions?: LLMOptions,
  ) {
    this.extensionId = extensionId;
    this.namespace = namespace || extensionId;
    this.database = database ?? defaultDb;

    this.state = new StateManager(this.extensionId, this.database);
    this.context = new ContextHydrator(this.database);
    this.graph = new GraphIngestor(this.namespace, this.database);
    this.ingest = new UnifiedIngestor(this.namespace, this.database);
    this.embedder = new EmbedderClient(defaultEmbedderOptions);
    this.search = new ChunkSearcher(this.database, this.embedder);

    const sharedLLMOptions: LLMOptions | undefined =
      defaultLLMOptions ??
      (defaultEmbedderOptions
        ? {
            apiKey: defaultEmbedderOptions.apiKey,
            baseUrl: defaultEmbedderOptions.baseUrl,
            endpoint: defaultEmbedderOptions.endpoint,
            fetchFn: defaultEmbedderOptions.fetchFn,
            timeoutMs: defaultEmbedderOptions.timeoutMs,
            maxRetries: defaultEmbedderOptions.maxRetries,
            client: defaultEmbedderOptions.client,
          }
        : undefined);
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
): ShaleSDK {
  return new ShaleSDK(
    extensionId,
    namespace,
    database,
    defaultEmbedderOptions,
    defaultLLMOptions,
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
    const sdk = createExtensionSDK(extId, ns);
    manifestSdkCache.set(discovered.path, sdk);
    return sdk;
  }

  // 4. Default fallback
  if (!defaultSdkInstance) {
    defaultSdkInstance = createExtensionSDK("default", "default");
  }
  return defaultSdkInstance;
}

export const getActiveSDK = getSDK;

// ---------------------------------------------------------------------------
// Convenience Proxies for Scoped Submodules
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Individual Convenience Functions
// ---------------------------------------------------------------------------

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

export default ShaleSDK;
