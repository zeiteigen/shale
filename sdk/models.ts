import { modelCoordinator } from "../lib/ai/scheduler";
import {
  resolveModelResource,
  resolveChatEndpoint,
  resolveEmbeddingEndpoint,
  type ModelRole,
} from "../lib/ai/config";
import type { LLMClient } from "./llm";
import type { EmbedderClient } from "./embed";
import { boundedMap } from "../lib/ai/bounded-map";
import { resolveChatBatchWidth, resolveBatchMode, resolveBatchEndpoint } from "../lib/ai/batch-config";
import { collectBatchRequests } from "../lib/ai/batch-dispatch";

/** Batch scheduling is shared across all SDK instances, including message handlers. */
export class ModelBatches {
  constructor(
    private readonly chat: LLMClient,
    private readonly embedding: EmbedderClient,
  ) {}

  private resource(): string | null {
    const profiles = [
      {
        options: this.chat.options(),
        endpoint: resolveBatchMode("chat", this.chat.options()) === "api"
          ? resolveBatchEndpoint("chat", this.chat.options()) : resolveChatEndpoint(this.chat.options()),
      },
      {
        options: this.embedding.options(),
        endpoint: resolveBatchMode("embedding", this.embedding.options()) === "api"
          ? resolveBatchEndpoint("embedding", this.embedding.options()) : resolveEmbeddingEndpoint(this.embedding.options()),
      },
    ];
    const resources = new Set(
      profiles
        .map(({ options, endpoint }) =>
          resolveModelResource(endpoint, options.resource),
        )
        .filter(Boolean),
    );
    if (resources.size > 1)
      throw new Error("A model batch must use one shared GPU resource");
    return resources.values().next().value ?? null;
  }

  batch<T, R>(
    prepare: () => Promise<T>,
    finalize: (prepared: T) => Promise<R>,
  ): Promise<R> {
    return modelCoordinator.batch(this.resource(), prepare, finalize);
  }

  phase<T>(role: ModelRole, work: () => Promise<T>): Promise<T> {
    return modelCoordinator.exclusive(this.resource(), () =>
      modelCoordinator.phase(role, work),
    );
  }

  /** Batch independent preparation tasks, including delegated processors and checkpoints. */
  mapChat<T, R>(items: readonly T[], work: (item: T, index: number) => Promise<R>): Promise<R[]> {
    if (!items.length) return Promise.resolve([]);
    return this.phase("chat", () => collectBatchRequests(() => boundedMap(items,
      resolveChatBatchWidth(this.chat.options()), work)));
  }
}
