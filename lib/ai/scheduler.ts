import { AsyncLocalStorage } from "node:async_hooks";
import { resolveModelResource, type ModelRole } from "./config";

interface Reservation {
  resource: string;
  active: boolean;
  pending: Set<Promise<unknown>>;
  phase?: ModelRole;
}
interface ModelScope {
  reservation?: Reservation;
  phase?: ModelRole;
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

  async phase<T>(phase: ModelRole, work: () => Promise<T>): Promise<T> {
    const parent = this.scope.getStore();
    if (parent?.phase && parent.phase !== phase) {
      throw new Error(
        `Cannot start ${phase} work during the ${parent.phase} phase`,
      );
    }
    if (parent?.reservation?.active) {
      if (parent.phase && parent.reservation.phase !== phase)
        throw new Error("This model phase has already completed");
      parent.reservation.phase = phase;
    }
    return this.scope.run({ ...parent, phase }, work);
  }

  async batch<T, R>(
    resource: string | null,
    prepare: () => Promise<T>,
    finalize: (prepared: T) => Promise<R>,
  ): Promise<R> {
    return this.exclusive(resource, async () => {
      const prepared = await this.phase("chat", prepare);
      await this.drain(this.scope.getStore()?.reservation);
      return this.phase("embedding", () => finalize(prepared));
    });
  }

  async request<T>(
    role: ModelRole,
    endpoint: string,
    work: () => Promise<T>,
    resource?: string | null,
  ): Promise<T> {
    const parent = this.scope.getStore();
    if (parent?.phase && parent.phase !== role) {
      throw new Error(
        `Cannot issue an ${role} request during the ${parent.phase} phase`,
      );
    }
    if (parent?.reservation?.active && parent.reservation.phase &&
        parent.reservation.phase !== role)
      throw new Error(`Cannot issue a ${role} request after its model phase completed`);
    const key = resolveModelResource(endpoint, resource);
    if (parent?.phase && key && !parent.reservation?.active) {
      throw new Error(
        "Declare the GPU resource in the batch profiles before issuing local requests",
      );
    }
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
