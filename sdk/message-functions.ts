import type { ExtensionMessages } from "./messages";
import type {
  MessageRequestOptions,
  MessagePublishOptions,
  HandlerRegistrationOptions,
  ListenerRegistrationOptions,
} from "../lib/messages.types";
import { getActiveSDK } from "./scope";

/** Resolve the SDK when a convenience function is called, not when it is imported. */
export const messages: ExtensionMessages = new Proxy({} as ExtensionMessages, {
  get(_target, prop) {
    const active = getActiveSDK().messages;
    const value = Reflect.get(active, prop, active);
    return typeof value === "function" ? value.bind(active) : value;
  },
});

export const requestMessage: ExtensionMessages["request"] = (
  channel: string,
  payload: any,
  options?: MessageRequestOptions,
) => getActiveSDK().messages.request(channel, payload, options);
export const sendMessage: ExtensionMessages["send"] = requestMessage;
export const publishMessage: ExtensionMessages["publish"] = (
  channel: string,
  payload: any,
  options?: MessagePublishOptions,
) => getActiveSDK().messages.publish(channel, payload, options);
export const handleMessage: ExtensionMessages["handle"] = (
  channel: string,
  handler: any,
  options?: HandlerRegistrationOptions,
) => getActiveSDK().messages.handle(channel, handler, options);
export const onMessage: ExtensionMessages["on"] = (
  channel: string,
  listener: any,
  options?: ListenerRegistrationOptions,
) => getActiveSDK().messages.on(channel, listener, options);
