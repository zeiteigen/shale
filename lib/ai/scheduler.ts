import { AsyncLocalStorage } from "node:async_hooks";
import { resolveModelResource } from "./config";

interface Reservation {
  resource: string;
  active: boolean;
  pending: Set<Promise<unknown>>;
}
interface ModelScope {
  reservation?: Reservation;
}

/** One coordinator per process. Servers/processes sharing a GPU need external coordination. */
export class ModelCoordinator {
  private readonly scope = new AsyncLocalStorage<ModelScope>();
  private readonly queues = new Map<string, Promise<void>>();

  async exclusive<T>(
    resource: string | null,
    work: () => Promise<T>,
  ): Promise<T> {
    if (!resource) return work();
    const parent = this.scope.getStore();
    if (parent?.reservation?.active && parent.reservation.resource === resource)
      return work();
    if (parent?.reservation?.active)
      throw new Error("A model batch cannot acquire a second GPU resource");
    const previous = this.queues.get(resource) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queues.set(resource, next);
    await previous;
    const reservation = {
      resource,
      active: true,
      pending: new Set<Promise<unknown>>(),
    };
    try {
      return await this.scope.run({ ...parent, reservation }, work);
    } finally {
      reservation.active = false;
      await this.drain(reservation);
      release();
      if (this.queues.get(resource) === next) this.queues.delete(resource);
    }
  }

  private async drain(reservation?: Reservation): Promise<void> {
    while (reservation?.pending.size)
      await Promise.allSettled([...reservation.pending]);
  }

  async batch<T, R>(
    resource: string | null,
    prepare: () => Promise<T>,
    finalize: (prepared: T) => Promise<R>,
  ): Promise<R> {
    return this.exclusive(resource, async () => {
      const prepared = await prepare();
      await this.drain(this.scope.getStore()?.reservation);
      return finalize(prepared);
    });
  }

  async request<T>(
    endpoint: string,
    work: () => Promise<T>,
    resource?: string | null,
  ): Promise<T> {
    const key = resolveModelResource(endpoint, resource);
    return this.exclusive(key, async () => {
      const reservation = this.scope.getStore()?.reservation;
      const pending = work();
      reservation?.pending.add(pending);
      try {
        return await pending;
      } finally {
        reservation?.pending.delete(pending);
      }
    });
  }
}

export const modelCoordinator = new ModelCoordinator();
