# Cross-extension messages

Use `sdk.messages.request()` for one response and `sdk.messages.publish()` for a broadcast. `send` and `emit` are aliases. `requestMessage`, `handleMessage`, `publishMessage`, and `onMessage` resolve the active SDK when called. The `messages` proxy resolves it when you access a property; an extracted method stays bound to that SDK. Shared channel contracts and transport types are exported from `@shale/sdk`.

```ts
sdk.messages.handle("file:can-process", (request, context) => {
  context.signal?.throwIfAborted();
  return { canProcess: request.filePath.endsWith(".png") };
});

const result = await sdk.messages.request("file:can-process", {
  filePath: "/tmp/diagram.png",
}, {
  target: "process-image",
  timeoutMs: 30_000,
  metadata: { jobId: "import-42" },
});
```

## Scope and routing

Handlers, capability predicates, and event listeners run in the receiving SDK's scope, including asynchronous work. Ambient settings, state, logger, and nested messaging therefore belong to the receiver. Sender identity is available as `context.senderId`; SDK clients set it automatically. The caller's GPU reservation and chat/embedding phase still propagate across the call, so a nested handler cannot issue embeddings during a chat phase.

Requests take a registration snapshot and examine handlers by descending priority, in registration order for ties. `target` matches an extension ID exactly or a handler name without regard to case. `canHandle` predicates run sequentially. A predicate failure is logged and selection continues; the first accepted handler executes once. A handler failure rejects the request without retrying another handler, which avoids duplicating side effects.

## Deadlines and cancellation

The default request deadline is 30 seconds and covers capability selection plus execution. Set `timeoutMs` explicitly for long model workloads. Existing callers can disable the deadline with a nonpositive or nonfinite value. An optional caller `signal` cancels the request. Both cancellation and timeout reject the response and abort `context.signal`.

Cancellation is cooperative: the bus cannot forcibly stop arbitrary JavaScript, synchronous work, or network calls. Handlers should check `context.signal`, pass it to operations that accept an abort signal, and forward it explicitly when making nested requests. A timed-out predicate cannot subsequently dispatch a handler. Existing GPU scheduling waits for already-running model requests to settle before releasing their reservation.

Metadata is exposed as `context.metadata`. Its top-level properties are copied and frozen at dispatch; nested metadata values and payloads remain shared references. Avoid mutating them during delivery.

## Events and cleanup

Publishing takes a listener snapshot. Priority controls invocation order; listeners complete concurrently. Failures are logged and isolated, and publication waits for all listeners. Registration changes affect the next publication. `once()` consumes its subscription before invoking the listener, including during recursive publication.

Every registration returns an unsubscribe function. `sdk.messages.clear()`, `reset()`, and `dispose()` remove only subscriptions registered through that SDK client. They do not cancel already-dispatched work or affect other SDK instances, even instances with the same extension ID. The host can clear the entire bus through `MessageBus.clear()` or `reset()`.

**Cleanup behavior changed:** extension-level `clear()` and `reset()` previously cleared the shared bus. Host code that intentionally needs global cleanup should call the bus explicitly.

## Code layout

- `lib/messages.ts`: bus facade and message envelopes.
- `lib/messages/registry.ts`: registration storage and snapshots.
- `lib/messages/request.ts`: routing, deadlines, and cancellation.
- `lib/messages/events.ts`: concurrent event delivery and failure isolation.
- `lib/messages/types.ts` and `contracts.ts`: transport types and shared channel contracts; `lib/messages.types.ts` remains a compatibility export.
- `sdk/messages.ts`: SDK ownership and callback scope.
- `sdk/message-api.ts`: channel overloads shared by clients and aliases. Inferred built-in channels enforce their payload and response types. Explicit generic custom calls and dynamic channel strings remain caller-typed for compatibility.
- `sdk/message-functions.ts`: ambient convenience functions and proxy.
- `sdk/storage.ts`: SDK async scope, separate from discovery and model scheduling.

Runtime coverage is in `tests/message-routing.test.ts` and `tests/cross-extension-messaging.test.ts`. Compile-only contract checks are in `tests/types/messages.ts`, using `tsc -p tests/types/tsconfig.json`.
