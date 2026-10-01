// Compile-only contract checks; this file never dispatches messages at runtime.
import {
  requestMessage,
  sendMessage,
  handleMessage,
  publishMessage,
  onMessage,
  type ExtensionMessages,
  type ProcessFileResponse,
  type MessageContext,
} from "../../sdk";

export function checkMessageTypes(client: ExtensionMessages) {
  const inferred: Promise<ProcessFileResponse> = client.request(
    "file:process",
    { filePath: "image.png" },
  );
  const ambient: Promise<ProcessFileResponse> = requestMessage("file:process", {
    filePath: "image.png",
  });
  const alias: Promise<ProcessFileResponse> = sendMessage("file:process", {
    filePath: "image.png",
  });
  const custom: Promise<number> = client.request<number>("custom:count", {});
  handleMessage("file:can-process", (payload, context) => {
    const path: string = payload.filePath;
    const typedContext: MessageContext = context;
    return { canProcess: !!path && !!typedContext.channel };
  });
  onMessage("source:ingested", (payload, context) => {
    const id: string = payload.sourceId;
    const typedContext: MessageContext = context;
    void [id, typedContext];
  });

  // @ts-expect-error Built-in request payloads must match their channel.
  client.request("search:query", { query: 42 });
  // @ts-expect-error Ambient wrappers preserve the payload contract.
  requestMessage("search:query", { unexpected: true });
  // @ts-expect-error Aliases preserve the same payload contract.
  sendMessage("search:query", { query: 42 });
  // @ts-expect-error Handler response must match the channel.
  client.handle("file:can-process", () => ({ canProcess: "yes" }));
  // @ts-expect-error Events cannot be dispatched as requests.
  client.request("source:ingested", {});
  // @ts-expect-error Requests cannot be dispatched as events.
  client.publish("search:query", { query: "wrong kind" });
  // @ts-expect-error Built-in events require their declared payload.
  publishMessage("source:ingested", { sourceId: "incomplete" });
  // @ts-expect-error Listener parameters cannot contradict the channel payload.
  onMessage("source:ingested", (_payload: number) => {});
  void [inferred, ambient, alias, custom];
}
