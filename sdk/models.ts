import { modelCoordinator } from "../lib/ai/scheduler";
import {
  resolveModelResource,
  resolveChatEndpoint,
} from "../lib/ai/config";
import type { LLMClient } from "./llm";
import { boundedMap } from "../lib/ai/bounded-map";
import { resolveChatBatchWidth, resolveBatchMode, resolveBatchEndpoint } from "../lib/ai/batch-config";
import { collectBatchRequests } from "../lib/ai/batch-dispatch";

/** Batch scheduling is shared across all SDK instances, including message handlers. */
export class ModelBatches {
  constructor(
    private readonly chat: LLMClient,
  ) {}

  private resource(): string | null {
    const options = this.chat.options();
    const endpoint = resolveBatchMode("chat", options) === "api"
      ? resolveBatchEndpoint("chat", options) : resolveChatEndpoint(options);
    return resolveModelResource(endpoint, options.resource);
  }

  batch<T, R>(
    prepare: () => Promise<T>,
    finalize: (prepared: T) => Promise<R>,
  ): Promise<R> {
    return modelCoordinator.batch(this.resource(), prepare, finalize);
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    return modelCoordinator.exclusive(this.resource(), work);
  }

  /** Batch independent preparation tasks, including delegated processors and checkpoints. */
  mapChat<T, R>(items: readonly T[], work: (item: T, index: number) => Promise<R>): Promise<R[]> {
    if (!items.length) return Promise.resolve([]);
    return this.run( () => collectBatchRequests(() => boundedMap(items,
      resolveChatBatchWidth(this.chat.options()), work)));
  }
}
