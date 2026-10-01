/**
 * Context provided to message handlers and event listeners.
 */
export interface MessageContext {
  /** Identifier of the extension that sent the message */
  senderId?: string;
  /** The channel/topic name */
  channel: string;
  /** Unique message identifier */
  messageId: string;
  /** Epoch millisecond timestamp of message dispatch */
  timestamp: number;
  /** Optional target extension ID if point-to-point dispatch */
  target?: string;
  /** Sender-supplied metadata, copied when dispatch begins. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Requests are aborted when their deadline expires or the sender cancels. */
  readonly signal?: AbortSignal;
}

/**
 * Options for sending a request expecting a response.
 */
export interface MessageRequestOptions {
  /** Deadline for routing and execution. Default: 30000ms; nonpositive/nonfinite disables it. */
  timeoutMs?: number;
  /** Optional caller cancellation. Handlers should observe context.signal. */
  signal?: AbortSignal;
  /** Sender extension ID (automatically injected by SDK) */
  senderId?: string;
  /** Target specific extension by name or ID */
  target?: string;
  /** Additional arbitrary metadata */
  metadata?: Record<string, any>;
}

/**
 * Options for publishing an event to listeners.
 */
export interface MessagePublishOptions {
  /** Sender extension ID (automatically injected by SDK) */
  senderId?: string;
  /** Additional arbitrary metadata */
  metadata?: Record<string, any>;
}

/**
 * Options for registering a request handler.
 */
export interface HandlerRegistrationOptions<TReq = any> {
  /** Friendly name for the handler (e.g. extension name) */
  name?: string;
  /** Predicate determining whether this handler can process a given request */
  canHandle?: (
    payload: TReq,
    context: MessageContext,
  ) => boolean | Promise<boolean>;
  /** Higher priority handlers are evaluated first. Default: 0. */
  priority?: number;
}

/**
 * Options for registering an event listener.
 */
export interface ListenerRegistrationOptions {
  /** Friendly name for the listener */
  name?: string;
  /** Higher priority listeners are called first. Default: 0. */
  priority?: number;
}

export type MessageRequestHandler<TReq = any, TResp = any> = (
  payload: TReq,
  context: MessageContext,
) => Promise<TResp> | TResp;

export type MessageListener<TPayload = any> = (
  payload: TPayload,
  context: MessageContext,
) => Promise<void> | void;
