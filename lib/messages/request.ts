import type {
  HandlerRegistrationOptions,
  MessageContext,
  MessageRequestHandler,
  MessageRequestOptions,
} from "../messages.types";

export interface RegisteredHandler extends HandlerRegistrationOptions {
  handler: MessageRequestHandler;
  extensionId?: string;
  priority: number;
}

/** One deadline covers both capability checks and execution. */
export async function dispatchRequest<T>(
  handlers: readonly RegisteredHandler[],
  payload: unknown,
  context: MessageContext,
  options: MessageRequestOptions = {},
): Promise<T> {
  const { channel } = context;
  if (!handlers.length)
    throw new Error(
      `No registered handler for channel "${channel}". Ensure the providing extension is loaded.`,
    );
  const candidates = options.target
    ? handlers.filter(
        (entry) =>
          entry.extensionId === options.target ||
          entry.name?.toLowerCase() === options.target!.toLowerCase(),
      )
    : handlers;
  if (!candidates.length)
    throw new Error(
      `No handler matching target "${options.target}" on channel "${channel}". Available handlers: [${handlers.map((entry) => entry.name ?? entry.extensionId ?? "anonymous").join(", ")}]`,
    );

  const controller = new AbortController();
  const scopedContext = Object.freeze({
    ...context,
    signal: controller.signal,
  });
  const timeoutMs = options.timeoutMs ?? 30000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const abort = (reason: unknown) => {
    if (controller.signal.aborted) return;
    // Reject before notifying handlers, so the cancellation reason wins the race.
    rejectAbort(reason);
    controller.abort(reason);
  };
  const cancel = () =>
    abort(
      options.signal?.reason ??
        new Error(`Request to channel "${channel}" aborted`),
    );
  options.signal?.addEventListener("abort", cancel, { once: true });
  if (options.signal?.aborted) cancel();
  if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
    timer = setTimeout(
      () =>
        abort(
          new Error(
            `Request to channel "${channel}" timed out after ${timeoutMs}ms`,
          ),
        ),
      timeoutMs,
    );
  }

  const route = async (): Promise<T> => {
    for (const entry of candidates) {
      controller.signal.throwIfAborted();
      if (entry.canHandle) {
        let accepted: boolean;
        try {
          accepted = await entry.canHandle(payload, scopedContext);
        } catch (error) {
          controller.signal.throwIfAborted();
          console.warn(
            `Error in canHandle predicate for handler "${entry.name ?? entry.extensionId ?? "anonymous"}" on channel "${channel}":`,
            error,
          );
          continue;
        }
        controller.signal.throwIfAborted();
        if (!accepted) continue;
      }
      return entry.handler(payload, scopedContext);
    }
    throw new Error(
      `No handler on channel "${channel}" accepted the request for payload.`,
    );
  };
  try {
    return await Promise.race([aborted, route()]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}
