import type { MessageContext, MessageListener } from "../messages.types";

export interface RegisteredListener {
  listener: MessageListener;
  name?: string;
  extensionId?: string;
  priority: number;
}

/** Priority controls invocation order; listeners finish concurrently and errors are isolated. */
export async function dispatchEvent(
  listeners: readonly RegisteredListener[],
  payload: unknown,
  context: MessageContext,
): Promise<void> {
  await Promise.all(
    listeners.map(async (entry) => {
      try {
        await entry.listener(payload, context);
      } catch (error) {
        console.error(
          `Error in event listener for channel "${context.channel}" (${entry.name ?? entry.extensionId ?? "anonymous"}):`,
          error,
        );
      }
    }),
  );
}
