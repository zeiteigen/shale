import type {
  MessageContext,
  MessageRequestOptions,
  MessagePublishOptions,
  HandlerRegistrationOptions,
  ListenerRegistrationOptions,
  MessageRequestHandler,
  MessageListener,
} from "./messages.types";

interface RegisteredHandler<TReq = any, TResp = any> {
  id: string;
  channel: string;
  handler: MessageRequestHandler<TReq, TResp>;
  name?: string;
  priority: number;
  canHandle?: (payload: TReq, context: MessageContext) => boolean | Promise<boolean>;
  extensionId?: string;
}

interface RegisteredListener<TPayload = any> {
  id: string;
  channel: string;
  listener: MessageListener<TPayload>;
  name?: string;
  priority: number;
  extensionId?: string;
}

/**
 * High-performance, asynchronous in-process message bus for cross-extension communication.
 */
export class MessageBus {
  private handlers = new Map<string, RegisteredHandler[]>();
  private listeners = new Map<string, RegisteredListener[]>();
  private messageCounter = 0;

  /**
   * Registers a request handler for a given channel.
   *
   * @param channel Channel name (e.g. "file:process")
   * @param handler Function handling the request
   * @param options Configuration options including priority, name, and canHandle predicate
   * @returns Unsubscribe function to remove this handler
   */
  handle<TReq = any, TResp = any>(
    channel: string,
    handler: MessageRequestHandler<TReq, TResp>,
    options?: HandlerRegistrationOptions<TReq> & { extensionId?: string },
  ): () => void {
    const id = `h_${channel}_${++this.messageCounter}_${Date.now()}`;
    const registered: RegisteredHandler<TReq, TResp> = {
      id,
      channel,
      handler,
      name: options?.name,
      priority: options?.priority ?? 0,
      canHandle: options?.canHandle,
      extensionId: options?.extensionId,
    };

    const list = this.handlers.get(channel) ?? [];
    list.push(registered);
    // Sort descending by priority so highest priority runs first
    list.sort((a, b) => b.priority - a.priority);
    this.handlers.set(channel, list);

    return () => {
      this.removeHandlerById(channel, id);
    };
  }

  /**
   * Dispatches a request to a registered handler and awaits the response.
   *
   * @param channel Channel name (e.g. "file:process")
   * @param payload Request payload
   * @param options Request options (timeout, target, senderId)
   */
  async request<TResp = any, TReq = any>(
    channel: string,
    payload: TReq,
    options?: MessageRequestOptions,
  ): Promise<TResp> {
    const handlers = this.handlers.get(channel);

    if (!handlers || handlers.length === 0) {
      throw new Error(
        `No registered handler for channel "${channel}". Ensure the providing extension is loaded.`,
      );
    }

    const messageId = `req_${++this.messageCounter}_${Date.now()}`;
    const context: MessageContext = {
      senderId: options?.senderId,
      channel,
      messageId,
      timestamp: Date.now(),
      target: options?.target,
    };

    // Filter by target extension or handler name if specified
    const candidateHandlers = options?.target
      ? handlers.filter(
          (h) =>
            h.name === options.target ||
            h.extensionId === options.target ||
            h.name?.toLowerCase() === options.target?.toLowerCase(),
        )
      : handlers;

    if (candidateHandlers.length === 0) {
      throw new Error(
        `No handler matching target "${options?.target}" on channel "${channel}". Available handlers: [${handlers.map((h) => h.name || h.extensionId || "anonymous").join(", ")}]`,
      );
    }

    // Find the first handler that accepts this request
    let selectedHandler: RegisteredHandler<TReq, TResp> | null = null;
    for (const candidate of candidateHandlers) {
      if (candidate.canHandle) {
        try {
          const accepted = await candidate.canHandle(payload, context);
          if (accepted) {
            selectedHandler = candidate;
            break;
          }
        } catch (canHandleErr) {
          console.warn(
            `Error in canHandle predicate for handler "${candidate.name ?? candidate.id}" on channel "${channel}":`,
            canHandleErr,
          );
        }
      } else {
        selectedHandler = candidate;
        break;
      }
    }

    if (!selectedHandler) {
      throw new Error(
        `No handler on channel "${channel}" accepted the request for payload.`,
      );
    }

    const timeoutMs = options?.timeoutMs ?? 30000;
    return this.executeWithTimeout(
      selectedHandler.handler(payload, context),
      timeoutMs,
      `Request to channel "${channel}" timed out after ${timeoutMs}ms`,
    );
  }

  /**
   * Registers a pub/sub event listener on a channel.
   *
   * @param channel Channel name (e.g. "source:ingested")
   * @param listener Callback function
   * @param options Listener configuration (priority, name)
   * @returns Unsubscribe function
   */
  on<TPayload = any>(
    channel: string,
    listener: MessageListener<TPayload>,
    options?: ListenerRegistrationOptions & { extensionId?: string },
  ): () => void {
    const id = `l_${channel}_${++this.messageCounter}_${Date.now()}`;
    const registered: RegisteredListener<TPayload> = {
      id,
      channel,
      listener,
      name: options?.name,
      priority: options?.priority ?? 0,
      extensionId: options?.extensionId,
    };

    const list = this.listeners.get(channel) ?? [];
    list.push(registered);
    list.sort((a, b) => b.priority - a.priority);
    this.listeners.set(channel, list);

    return () => {
      this.removeListenerById(channel, id);
    };
  }

  /**
   * Registers a one-time event listener on a channel.
   */
  once<TPayload = any>(
    channel: string,
    listener: MessageListener<TPayload>,
    options?: ListenerRegistrationOptions & { extensionId?: string },
  ): () => void {
    const unsubscribe = this.on(
      channel,
      async (payload, context) => {
        unsubscribe();
        await listener(payload, context);
      },
      options,
    );
    return unsubscribe;
  }

  /**
   * Broadcasts an event to all registered listeners on a channel.
   *
   * @param channel Channel name
   * @param payload Event payload
   * @param options Publish options
   */
  async publish<TPayload = any>(
    channel: string,
    payload: TPayload,
    options?: MessagePublishOptions,
  ): Promise<void> {
    const list = this.listeners.get(channel);
    if (!list || list.length === 0) {
      return;
    }

    const messageId = `pub_${++this.messageCounter}_${Date.now()}`;
    const context: MessageContext = {
      senderId: options?.senderId,
      channel,
      messageId,
      timestamp: Date.now(),
    };

    // Execute listeners concurrently using Promise.allSettled
    const results = await Promise.allSettled(
      list.map(async (entry) => {
        try {
          await entry.listener(payload, context);
        } catch (err) {
          console.error(
            `Error in event listener for channel "${channel}" (${entry.name ?? entry.id}):`,
            err,
          );
        }
      }),
    );
  }

  /**
   * Returns whether a channel has at least one registered request handler.
   */
  hasHandler(channel: string): boolean {
    const list = this.handlers.get(channel);
    return Boolean(list && list.length > 0);
  }

  /**
   * Returns whether a channel has at least one registered event listener.
   */
  hasListeners(channel: string): boolean {
    const list = this.listeners.get(channel);
    return Boolean(list && list.length > 0);
  }

  /**
   * Returns all active channels with registered handlers or listeners.
   */
  getChannels(): string[] {
    const set = new Set<string>();
    for (const ch of this.handlers.keys()) set.add(ch);
    for (const ch of this.listeners.keys()) set.add(ch);
    return Array.from(set);
  }

  /**
   * Removes all handlers and listeners for this bus.
   */
  clear(): void {
    this.handlers.clear();
    this.listeners.clear();
  }

  /**
   * Resets the message bus to its initial state.
   */
  reset(): void {
    this.clear();
    this.messageCounter = 0;
  }

  private removeHandlerById(channel: string, id: string): boolean {
    const list = this.handlers.get(channel);
    if (!list) return false;
    const initialLen = list.length;
    const filtered = list.filter((h) => h.id !== id);
    if (filtered.length === 0) {
      this.handlers.delete(channel);
    } else {
      this.handlers.set(channel, filtered);
    }
    return filtered.length < initialLen;
  }

  private removeListenerById(channel: string, id: string): boolean {
    const list = this.listeners.get(channel);
    if (!list) return false;
    const initialLen = list.length;
    const filtered = list.filter((l) => l.id !== id);
    if (filtered.length === 0) {
      this.listeners.delete(channel);
    } else {
      this.listeners.set(channel, filtered);
    }
    return filtered.length < initialLen;
  }

  private async executeWithTimeout<T>(
    promiseOrVal: Promise<T> | T,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<T> {
    if (timeoutMs <= 0 || !Number.isFinite(timeoutMs)) {
      return await promiseOrVal;
    }

    let timer: Timer | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(timeoutMessage));
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([promiseOrVal, timeoutPromise]);
      return result;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** Default singleton instance of the message bus shared across the Shale host */
export const defaultMessageBus = new MessageBus();

/** Factory function to create isolated message buses (useful for testing) */
export function createMessageBus(): MessageBus {
  return new MessageBus();
}

export default defaultMessageBus;
