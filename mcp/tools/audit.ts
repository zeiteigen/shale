import type { ShaleSDK } from "../../sdk";
import { mutationContext } from "../../sdk/knowledge/schemas";

export function auditContext(reason: string) {
  return { ...mutationContext, reason: mutationContext.reason.default(reason) };
}

/** Keep audit context separate from the input passed to a legacy graph mutation. */
export function recordToolMutation<T extends { actor: string; reason: string; requestId?: string }, R>(
  sdk: ShaleSDK,
  action: string,
  args: T,
  work: (input: Omit<T, "actor" | "reason" | "requestId">, context: { actor: string; reason: string; requestId?: string }) => R,
) {
  const { actor, reason, requestId, ...input } = args;
  const context = { actor, reason, requestId };
  return sdk.knowledge.record(action, input, context, (prepared) => work(prepared as typeof input, context));
}
