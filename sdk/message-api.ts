import type {
  BuiltinChannelDefinitions,
  BuiltinRequestChannels,
  BuiltinEventChannels,
  MessageRequestOptions,
  MessagePublishOptions,
  MessageRequestHandler,
  MessageListener,
  HandlerRegistrationOptions,
  ListenerRegistrationOptions,
} from "../lib/messages.types";

type CustomChannel<C extends string> = C &
  (C extends keyof BuiltinChannelDefinitions ? never : unknown);

/** Shared signatures for scoped clients, aliases, and ambient convenience functions. */
export interface RequestMessage {
  <K extends BuiltinRequestChannels>(
    channel: K,
    payload: BuiltinChannelDefinitions[K]["request"],
    options?: MessageRequestOptions,
  ): Promise<BuiltinChannelDefinitions[K]["response"]>;
  <TResp = any, TReq = any, C extends string = string>(
    channel: CustomChannel<C>,
    payload: TReq,
    options?: MessageRequestOptions,
  ): Promise<TResp>;
}

export interface HandleMessage {
  <K extends BuiltinRequestChannels>(
    channel: K,
    handler: MessageRequestHandler<
      BuiltinChannelDefinitions[K]["request"],
      BuiltinChannelDefinitions[K]["response"]
    >,
    options?: HandlerRegistrationOptions<
      BuiltinChannelDefinitions[K]["request"]
    >,
  ): () => void;
  <TReq = any, TResp = any, C extends string = string>(
    channel: CustomChannel<C>,
    handler: MessageRequestHandler<TReq, TResp>,
    options?: HandlerRegistrationOptions<TReq>,
  ): () => void;
}

export interface PublishMessage {
  <K extends BuiltinEventChannels>(
    channel: K,
    payload: BuiltinChannelDefinitions[K]["payload"],
    options?: MessagePublishOptions,
  ): Promise<void>;
  <TPayload = any, C extends string = string>(
    channel: CustomChannel<C>,
    payload: TPayload,
    options?: MessagePublishOptions,
  ): Promise<void>;
}

export interface OnMessage {
  <K extends BuiltinEventChannels>(
    channel: K,
    listener: MessageListener<BuiltinChannelDefinitions[K]["payload"]>,
    options?: ListenerRegistrationOptions,
  ): () => void;
  <TPayload = any, C extends string = string>(
    channel: CustomChannel<C>,
    listener: MessageListener<TPayload>,
    options?: ListenerRegistrationOptions,
  ): () => void;
}
