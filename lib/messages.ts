import type {
  MessageContext,
  MessageRequestOptions,
  MessagePublishOptions,
  HandlerRegistrationOptions,
  ListenerRegistrationOptions,
  MessageRequestHandler,
  MessageListener,
} from "./messages.types";
import { RegistrationRegistry } from "./messages/registry";
import { dispatchRequest, type RegisteredHandler } from "./messages/request";
import { dispatchEvent, type RegisteredListener } from "./messages/events";

/** In-process routing and pub/sub. The host owns this bus; extensions own subscriptions. */
export class MessageBus {
  private readonly handlers = new RegistrationRegistry<RegisteredHandler>();
  private readonly listeners = new RegistrationRegistry<RegisteredListener>();
  private messageCounter = 0;

  handle<TReq = any, TResp = any>(
    channel: string,
    handler: MessageRequestHandler<TReq, TResp>,
    options?: HandlerRegistrationOptions<TReq> & { extensionId?: string },
  ): () => void {
    return this.handlers.add(channel, {
      ...options,
      handler,
      priority: options?.priority ?? 0,
    });
  }

  request<TResp = any, TReq = any>(
    channel: string,
    payload: TReq,
    options?: MessageRequestOptions,
  ): Promise<TResp> {
    return dispatchRequest(
      this.handlers.snapshot(channel),
      payload,
      this.context("req", channel, options),
      options,
    );
  }

  on<TPayload = any>(
    channel: string,
    listener: MessageListener<TPayload>,
    options?: ListenerRegistrationOptions & { extensionId?: string },
  ): () => void {
    return this.listeners.add(channel, {
      ...options,
      listener,
      priority: options?.priority ?? 0,
    });
  }

  once<TPayload = any>(
    channel: string,
    listener: MessageListener<TPayload>,
    options?: ListenerRegistrationOptions & { extensionId?: string },
  ): () => void {
    let consumed = false;
    const unsubscribe = this.on(
      channel,
      (payload: TPayload, context) => {
        if (consumed) return;
        consumed = true;
        unsubscribe();
        return listener(payload, context);
      },
      options,
    );
    return unsubscribe;
  }

  publish<TPayload = any>(
    channel: string,
    payload: TPayload,
    options?: MessagePublishOptions,
  ): Promise<void> {
    return dispatchEvent(
      this.listeners.snapshot(channel),
      payload,
      this.context("pub", channel, options),
    );
  }

  hasHandler(channel: string): boolean {
    return this.handlers.has(channel);
  }
  hasListeners(channel: string): boolean {
    return this.listeners.has(channel);
  }
  getChannels(): string[] {
    return [...new Set([...this.handlers.keys(), ...this.listeners.keys()])];
  }

  /** Global cleanup belongs to the host, not an extension's SDK. */
  clear(): void {
    this.handlers.clear();
    this.listeners.clear();
  }
  reset(): void {
    this.clear();
  }

  private context(
    kind: string,
    channel: string,
    options?: MessageRequestOptions,
  ): MessageContext {
    return Object.freeze({
      senderId: options?.senderId,
      channel,
      messageId: `${kind}_${++this.messageCounter}_${Date.now()}`,
      timestamp: Date.now(),
      target: options?.target,
      metadata: options?.metadata
        ? Object.freeze({ ...options.metadata })
        : undefined,
    });
  }
}

export const defaultMessageBus = new MessageBus();
export function createMessageBus(): MessageBus {
  return new MessageBus();
}
export default defaultMessageBus;
