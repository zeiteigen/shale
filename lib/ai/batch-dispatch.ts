import { AsyncLocalStorage } from "node:async_hooks";
import { executeAPIBatch } from "./api-batch";
import { resolveBatchEndpoint, resolveBatchTimeout, resolveBatchPollInterval } from "./batch-config";
import { resolveApiKey, resolveTimeout, resolveRetries, type ModelRole } from "./config";
import type { AIClientOptions } from "./types";

interface Pending {
  body: unknown;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}
interface Group { role: ModelRole; options?: AIClientOptions; pending: Pending[] }
const scope = new AsyncLocalStorage<Map<string, Group>>();
const identities = new WeakMap<object, number>();
let nextIdentity = 0;
function identity(value?: object | null): number {
  if (!value) return 0;
  if (!identities.has(value)) identities.set(value, ++nextIdentity);
  return identities.get(value)!;
}

/** Gather concurrent requests without changing extension prompts or response handling. */
export function collectBatchRequests<T>(work: () => Promise<T>): Promise<T> {
  return scope.getStore() ? work() : scope.run(new Map(), work);
}

export function dispatchBatchRequest<T>(role: ModelRole, body: { model: string }, options?: AIClientOptions): Promise<T> {
  const groups = scope.getStore();
  if (!groups) return executeAPIBatch<T>(role, [body], options).then(results => results[0]);
  const endpoint = resolveBatchEndpoint(role, options);
  const transportOptions = { ...options, endpoint };
  const key = JSON.stringify([role, body.model, endpoint, resolveApiKey(options, role),
    resolveTimeout(transportOptions, role), resolveRetries(transportOptions, role), resolveBatchTimeout(options), resolveBatchPollInterval(options),
    identity(options?.client), identity(options?.fetchFn), identity(options?.signal), identity(options?.batchStore)]);
  return new Promise<T>((resolve, reject) => {
    let group = groups.get(key);
    if (!group) {
      group = { role, options, pending: [] };
      groups.set(key, group);
      const current = group;
      setTimeout(() => {
        groups.delete(key);
        void executeAPIBatch<unknown>(current.role, current.pending.map(item => item.body), current.options)
          .then(results => current.pending.forEach((item, index) => item.resolve(results[index])),
            error => current.pending.forEach(item => item.reject(error)));
      }, 0);
    }
    group.pending.push({ body, resolve: value => resolve(value as T), reject });
  });
}
