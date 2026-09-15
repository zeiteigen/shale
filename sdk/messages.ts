import {
  MessageBus,
  defaultMessageBus,
} from "../lib/messages";
import type {
  MessageContext,
  MessageRequestOptions,
  MessagePublishOptions,
  HandlerRegistrationOptions,
  ListenerRegistrationOptions,
  MessageRequestHandler,
  MessageListener,
  BuiltinChannelDefinitions,
  BuiltinRequestChannels,
  BuiltinEventChannels,
} from "../lib/messages.types";
import type { Logger } from "./logger";

/**
 * Extension-scoped client for Shale cross-extension messaging.
 * Automatically attributes messages to the calling extension and provides
 * type safety for built-in channels as well as arbitrary topics.
 */
export class ExtensionMessages {
  readonly extensionId: string;
  readonly bus: MessageBus;
  private readonly logger?: Logger;

  constructor(
    extensionId: string,
    bus?: MessageBus,
    logger?: Logger,
  ) {
    this.extensionId = extensionId;
    this.bus = bus ?? defaultMessageBus;
    this.logger = logger;
  }

  /**
   * Sends a request expecting a response over a built-in or arbitrary channel.
   * Built-in channels are fully type-safe with automatic payload and return type inference.
   */
  async request<K extends BuiltinRequestChannels>(
    channel: K,
    payload: BuiltinChannelDefinitions[K]["request"],
    options?: MessageRequestOptions,
  ): Promise<BuiltinChannelDefinitions[K]["response"]>;
  async request<TResp = any, TReq = any>(
    channel: string,
    payload: TReq,
    options?: MessageRequestOptions,
  ): Promise<TResp>;
  async request(
    channel: string,
    payload: any,
    options?: MessageRequestOptions,
  ): Promise<any> {
    const enrichedOptions: MessageRequestOptions = {
      senderId: this.extensionId,
      ...options,
    };
    return this.bus.request(channel, payload, enrichedOptions);
  }

  /**
   * Alias for request().
   */
  async send<K extends BuiltinRequestChannels>(
    channel: K,
    payload: BuiltinChannelDefinitions[K]["request"],
    options?: MessageRequestOptions,
  ): Promise<BuiltinChannelDefinitions[K]["response"]>;
  async send<TResp = any, TReq = any>(
    channel: string,
    payload: TReq,
    options?: MessageRequestOptions,
  ): Promise<TResp>;
  async send(
    channel: string,
    payload: any,
    options?: MessageRequestOptions,
  ): Promise<any> {
    return this.request(channel as any, payload, options);
  }

  /**
   * Registers a request handler for a built-in or arbitrary channel.
   */
  handle<K extends BuiltinRequestChannels>(
    channel: K,
    handler: (
      payload: BuiltinChannelDefinitions[K]["request"],
      context: MessageContext,
    ) =>
      | Promise<BuiltinChannelDefinitions[K]["response"]>
      | BuiltinChannelDefinitions[K]["response"],
    options?: HandlerRegistrationOptions<BuiltinChannelDefinitions[K]["request"]>,
  ): () => void;
  handle<TReq = any, TResp = any>(
    channel: string,
    handler: MessageRequestHandler<TReq, TResp>,
    options?: HandlerRegistrationOptions<TReq>,
  ): () => void;
  handle(
    channel: string,
    handler: (payload: any, context: MessageContext) => any,
    options?: HandlerRegistrationOptions<any>,
  ): () => void {
    const enrichedOptions = {
      name: options?.name ?? this.extensionId,
      extensionId: this.extensionId,
      ...options,
    };
    return this.bus.handle(channel, handler, enrichedOptions);
  }

  /**
   * Broadcasts an event to all subscribers on a built-in or arbitrary channel.
   */
  async publish<K extends BuiltinEventChannels>(
    channel: K,
    payload: BuiltinChannelDefinitions[K]["payload"],
    options?: MessagePublishOptions,
  ): Promise<void>;
  async publish<TPayload = any>(
    channel: string,
    payload: TPayload,
    options?: MessagePublishOptions,
  ): Promise<void>;
  async publish(
    channel: string,
    payload: any,
    options?: MessagePublishOptions,
  ): Promise<void> {
    const enrichedOptions: MessagePublishOptions = {
      senderId: this.extensionId,
      ...options,
    };
    return this.bus.publish(channel, payload, enrichedOptions);
  }

  /**
   * Alias for publish().
   */
  async emit<K extends BuiltinEventChannels>(
    channel: K,
    payload: BuiltinChannelDefinitions[K]["payload"],
    options?: MessagePublishOptions,
  ): Promise<void>;
  async emit<TPayload = any>(
    channel: string,
    payload: TPayload,
    options?: MessagePublishOptions,
  ): Promise<void>;
  async emit(
    channel: string,
    payload: any,
    options?: MessagePublishOptions,
  ): Promise<void> {
    return this.publish(channel as any, payload, options);
  }

  /**
   * Subscribes to events on a channel.
   */
  on<K extends BuiltinEventChannels>(
    channel: K,
    listener: (
      payload: BuiltinChannelDefinitions[K]["payload"],
      context: MessageContext,
    ) => void | Promise<void>,
    options?: ListenerRegistrationOptions,
  ): () => void;
  on<TPayload = any>(
    channel: string,
    listener: MessageListener<TPayload>,
    options?: ListenerRegistrationOptions,
  ): () => void;
  on(
    channel: string,
    listener: (payload: any, context: MessageContext) => any,
    options?: ListenerRegistrationOptions,
  ): () => void {
    const enrichedOptions = {
      name: options?.name ?? this.extensionId,
      extensionId: this.extensionId,
      ...options,
    };
    return this.bus.on(channel, listener, enrichedOptions);
  }

  /**
   * Subscribes to a single event on a channel.
   */
  once<K extends BuiltinEventChannels>(
    channel: K,
    listener: (
      payload: BuiltinChannelDefinitions[K]["payload"],
      context: MessageContext,
    ) => void | Promise<void>,
    options?: ListenerRegistrationOptions,
  ): () => void;
  once<TPayload = any>(
    channel: string,
    listener: MessageListener<TPayload>,
    options?: ListenerRegistrationOptions,
  ): () => void;
  once(
    channel: string,
    listener: (payload: any, context: MessageContext) => any,
    options?: ListenerRegistrationOptions,
  ): () => void {
    const enrichedOptions = {
      name: options?.name ?? this.extensionId,
      extensionId: this.extensionId,
      ...options,
    };
    return this.bus.once(channel, listener, enrichedOptions);
  }

  /**
   * Returns whether a channel has any registered request handlers.
   */
  hasHandler(channel: string): boolean {
    return this.bus.hasHandler(channel);
  }

  /**
   * Returns whether a channel has any registered event listeners.
   */
  hasListeners(channel: string): boolean {
    return this.bus.hasListeners(channel);
  }

  /**
   * Returns all channels currently registered on the bus.
   */
  getChannels(): string[] {
    return this.bus.getChannels();
  }

  /**
   * Clears all registered handlers and listeners on the underlying bus.
   */
  clear(): void {
    this.bus.clear();
  }

  /**
   * Resets the underlying bus.
   */
  reset(): void {
    this.bus.reset();
  }
}

export default ExtensionMessages;
