import type { Database } from "bun:sqlite";
import defaultDb from "../lib/db-init";
import { StateManager } from "./state";
import { ContextHydrator } from "./context";
import { CheckpointManager } from "./checkpoint";
import { GraphIngestor } from "./graph";
import { KnowledgeEditor } from './knowledge/changes';
import { UnifiedIngestor } from "./ingest";
import {
  LLMClient,
  type LLMOptions,
  type LLMResponse,
  type LLMQueryInput,
} from "./llm";
import { ChunkSearcher } from "./search";
import { SettingsManager } from "./settings";
import { ModelBatches } from "./models";
import { modelBatchStore } from "./model-batch-store";
import type { ExtensionSDKOptions } from "./sdk-options";
import { mergeOptions } from "../lib/ai/options";
import { Logger } from "./logger";
import { ExtensionMessages } from "./messages";
import { runWithSDK } from "./storage";
import { defaultMessageBus, type MessageBus } from "../lib/messages";
import type {
  CheckpointItem,
  CheckpointContext,
  SaveCheckpointOptions,
} from "./types";

export class ShaleSDK {
  readonly state: StateManager;
  readonly context: ContextHydrator;
  readonly checkpoint: CheckpointManager;
  readonly graph: GraphIngestor;
  readonly knowledge: KnowledgeEditor;
  readonly ingest: UnifiedIngestor;
  readonly llm: LLMClient;
  readonly models: ModelBatches;
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
    namespace?: string | ExtensionSDKOptions,
    database?: Database,
    defaultLLMOptions?: LLMOptions,
    extensionName?: string,
    extensionDir?: string,
    messageBus?: MessageBus,
  ) {
    const configured = typeof namespace === "object" ? namespace : undefined;
    if (configured) {
      namespace = configured.namespace;
      database = configured.database;
      extensionName = configured.extensionName;
      extensionDir = configured.extensionDir;
      messageBus = configured.messageBus;
      const shared = configured.models?.connection;
      if (shared?.endpoint)
        throw new Error(
          "Shared model connections must specify a baseUrl, not a role-specific endpoint",
        );
      defaultLLMOptions = mergeOptions(shared, configured.models?.chat);
    }
    this.extensionId = extensionId;
    this.extensionName = extensionName || extensionId;
    this.namespace =
      (typeof namespace === "string" && namespace) || extensionId;
    this.database = database ?? defaultDb;
    this.extensionDir = extensionDir;

    this.logger = new Logger(this.extensionName);
    this.messages = new ExtensionMessages(
      this.extensionId,
      messageBus ?? defaultMessageBus,
      this.logger,
      (work) => runWithSDK(this, work),
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
    const batchStore = modelBatchStore(this.state);
    this.search = new ChunkSearcher(this.database);
    this.knowledge = new KnowledgeEditor(this.database,this.graph,this.search,this.namespace);

    this.llm = new LLMClient({ batchStore, ...defaultLLMOptions });
    this.models = new ModelBatches(this.llm);
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

  queryLLMBatch(inputs: readonly (string | LLMQueryInput)[], options: LLMOptions & { detailed: true }): Promise<LLMResponse[]>;
  queryLLMBatch(inputs: readonly (string | LLMQueryInput)[], options?: LLMOptions): Promise<string[]>;
  queryLLMBatch(inputs: readonly (string | LLMQueryInput)[], options?: LLMOptions): Promise<string[] | LLMResponse[]> {
    return this.llm.queryBatch(inputs, options as any);
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
 * @param defaultLLMOptions Optional LLM client configuration
 */
export function createExtensionSDK(
  extensionId: string,
  namespace?: string | ExtensionSDKOptions,
  database?: Database,
  defaultLLMOptions?: LLMOptions,
  extensionName?: string,
  extensionDir?: string,
  messageBus?: MessageBus,
): ShaleSDK {
  return new ShaleSDK(
    extensionId,
    namespace,
    database,
    defaultLLMOptions,
    extensionName,
    extensionDir,
    messageBus,
  );
}

// ---------------------------------------------------------------------------
// Ambient Context & Automatic Manifest Discovery
// ---------------------------------------------------------------------------

export default ShaleSDK;
