export type QueueHandler<T> = (item: T) => Promise<void> | void;
export type QueueBeforeHandler<T> = (item: T) => Promise<void> | void;

export interface HandlerOptions<T> {
  onError?: (error: unknown, item: T) => void | Promise<void>;
}

interface WorkerState<T> {
  handler: QueueHandler<T>;
  queue: T[];
  processing: boolean;
  onError?: (error: unknown, item: T) => void | Promise<void>;
}

export class QueueManager<T = unknown> {
  private workers: Set<WorkerState<T>> = new Set();

  constructor(private readonly beforeHandler?: QueueBeforeHandler<T>) {}

  /**
   * Registers a handler to process items added to the queue.
   * Each handler receives items sequentially in FIFO order and is only
   * handed the next item once it has completed processing the previous one.
   *
   * @param handler Function to process each item
   * @param options Optional configuration like onError handler
   * @returns Unsubscribe function to remove this handler
   */
  addHandler(
    handler: QueueHandler<T>,
    options?: HandlerOptions<T>
  ): () => void {
    const worker: WorkerState<T> = {
      handler,
      queue: [],
      processing: false,
      onError: options?.onError,
    };

    this.workers.add(worker);

    return () => {
      this.removeHandler(handler);
    };
  }

  /**
   * Removes a registered handler from the queue manager.
   */
  removeHandler(handler: QueueHandler<T>): boolean {
    for (const worker of this.workers) {
      if (worker.handler === handler) {
        worker.queue = [];
        this.workers.delete(worker);
        return true;
      }
    }
    return false;
  }

  /**
   * Pushes a new item to the queue, notifying all registered handlers.
   * Handlers will process items independently at their own pace.
   */
  push(item: T): void {
    for (const worker of this.workers) {
      worker.queue.push(item);
      this.processWorker(worker);
    }
  }

  /**
   * Alias for push.
   */
  add(item: T): void {
    this.push(item);
  }

  /**
   * Pushes multiple items to the queue in order.
   */
  pushMany(items: Iterable<T>): void {
    for (const item of items) {
      this.push(item);
    }
  }

  private async processWorker(worker: WorkerState<T>): Promise<void> {
    if (worker.processing || worker.queue.length === 0) {
      return;
    }

    worker.processing = true;

    try {
      while (worker.queue.length > 0 && this.workers.has(worker)) {
        const item = worker.queue.shift()!;
        try {
          await this.beforeHandler?.(item);
          await worker.handler(item);
        } catch (error) {
          if (worker.onError) {
            try {
              await worker.onError(error, item);
            } catch (err) {
              console.error("Error in queue handler onError callback:", err);
            }
          } else {
            console.error("Unhandled error in queue handler:", error);
          }
        }
      }
    } finally {
      worker.processing = false;
      // In case items were added right around the boundary or after removal
      if (worker.queue.length > 0 && this.workers.has(worker)) {
        this.processWorker(worker);
      }
    }
  }

  /**
   * Returns whether any handler is currently processing or has items in its queue.
   */
  isProcessing(): boolean {
    for (const worker of this.workers) {
      if (worker.processing || worker.queue.length > 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * Returns the number of registered handlers.
   */
  get size(): number {
    return this.workers.size;
  }

  /**
   * Returns the number of pending items for a specific handler.
   */
  getPendingCount(handler: QueueHandler<T>): number | undefined {
    for (const worker of this.workers) {
      if (worker.handler === handler) {
        return worker.queue.length + (worker.processing ? 1 : 0);
      }
    }
    return undefined;
  }

  /**
   * Clears pending queues for all workers without removing the handlers.
   */
  clear(): void {
    for (const worker of this.workers) {
      worker.queue = [];
    }
  }

  /**
   * Resolves when all handlers have finished processing all queued items.
   */
  async idle(): Promise<void> {
    while (this.isProcessing()) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

export default QueueManager;
