import { MessageBus, defaultMessageBus } from "../lib/messages";
import type {
  MessageRequestOptions,
  MessagePublishOptions,
  MessageRequestHandler,
  MessageListener,
  HandlerRegistrationOptions,
  ListenerRegistrationOptions,
} from "../lib/messages.types";
import type {
  RequestMessage,
  HandleMessage,
  PublishMessage,
  OnMessage,
} from "./message-api";
import type { Logger } from "./logger";

export type MessageScope = <T>(work: () => T) => T;

/** Extension identity, callback scope, and subscription ownership. */
export class ExtensionMessages {
  readonly bus: MessageBus;
  private readonly subscriptions = new Set<() => void>();

  constructor(
    readonly extensionId: string,
    bus?: MessageBus,
    // Retained for compatibility with existing constructor calls.
    _logger?: Logger,
    private readonly runInScope: MessageScope = (work) => work(),
  ) {
    this.bus = bus ?? defaultMessageBus;
  }

  readonly request: RequestMessage = (
    channel: string,
    payload: any,
    options?: MessageRequestOptions,
  ) =>
    this.bus.request(channel, payload, {
      ...options,
      senderId: this.extensionId,
    });
  readonly send: RequestMessage = this.request;

  readonly handle: HandleMessage = (
    channel: string,
    handler: MessageRequestHandler,
    options?: HandlerRegistrationOptions,
  ) =>
    this.track(
      this.bus.handle(
        channel,
        (payload, context) => this.runInScope(() => handler(payload, context)),
        {
          ...options,
          name: options?.name ?? this.extensionId,
          extensionId: this.extensionId,
          canHandle: options?.canHandle
            ? (payload, context) =>
                this.runInScope(() => options.canHandle!(payload, context))
            : undefined,
        },
      ),
    );

  readonly publish: PublishMessage = (
    channel: string,
    payload: any,
    options?: MessagePublishOptions,
  ) =>
    this.bus.publish(channel, payload, {
      ...options,
      senderId: this.extensionId,
    });
  readonly emit: PublishMessage = this.publish;

  readonly on: OnMessage = (
    channel: string,
    listener: MessageListener,
    options?: ListenerRegistrationOptions,
  ) => this.subscribe(false, channel, listener, options);
  readonly once: OnMessage = (
    channel: string,
    listener: MessageListener,
    options?: ListenerRegistrationOptions,
  ) => this.subscribe(true, channel, listener, options);

  hasHandler(channel: string): boolean {
    return this.bus.hasHandler(channel);
  }
  hasListeners(channel: string): boolean {
    return this.bus.hasListeners(channel);
  }
  getChannels(): string[] {
    return this.bus.getChannels();
  }

  /** Removes only registrations created through this SDK client. In-flight work continues. */
  clear(): void {
    for (const unsubscribe of this.subscriptions) unsubscribe();
  }
  reset(): void {
    this.clear();
  }
  dispose(): void {
    this.clear();
  }

  private track(remove: () => void): () => void {
    const unsubscribe = () => {
      this.subscriptions.delete(unsubscribe);
      remove();
    };
    this.subscriptions.add(unsubscribe);
    return unsubscribe;
  }

  private subscribe(
    once: boolean,
    channel: string,
    listener: MessageListener,
    options?: ListenerRegistrationOptions,
  ): () => void {
    let unsubscribe!: () => void;
    const callback: MessageListener = (payload, context) => {
      if (once) unsubscribe();
      return this.runInScope(() => listener(payload, context));
    };
    const registration = {
      ...options,
      name: options?.name ?? this.extensionId,
      extensionId: this.extensionId,
    };
    unsubscribe = this.track(
      once
        ? this.bus.once(channel, callback, registration)
        : this.bus.on(channel, callback, registration),
    );
    return unsubscribe;
  }
}

export default ExtensionMessages;
