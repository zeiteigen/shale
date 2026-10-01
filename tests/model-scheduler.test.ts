import { describe, expect, it } from "bun:test";
import { ModelCoordinator } from "../lib/ai/scheduler";
import { MessageBus } from "../lib/messages";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const endpoint = "http://localhost:11434/v1";

describe("Shared GPU scheduling", () => {
  it("rejects chat continuations that wake up after embedding has begun", async () => {
    const coordinator = new ModelCoordinator();
    const wake = deferred();
    let late!: Promise<void>;
    let called = false;
    await coordinator.batch("local-gpu", async () => {
      late = (async () => {
        await wake.promise;
        await expect(coordinator.request("chat", endpoint, async () => {
          called = true;
        })).rejects.toThrow("phase completed");
      })();
    }, async () => {
      wake.resolve();
      await late;
    });
    expect(called).toBe(false);
  });

  it("drains timed-out message requests before starting the embedding phase", async () => {
    const coordinator = new ModelCoordinator();
    const bus = new MessageBus();
    const network = deferred();
    const timedOut = deferred();
    const calls: string[] = [];
    bus.handle("slow-vision", () => coordinator.request("chat", endpoint, async () => {
      calls.push("chat started");
      await network.promise;
      calls.push("chat finished");
    }));
    const batch = coordinator.batch("local-gpu", async () => {
      await expect(bus.request("slow-vision", {}, { timeoutMs: 5 })).rejects.toThrow("timed out");
      timedOut.resolve();
    }, () => coordinator.request("embedding", endpoint, async () => {
      calls.push("embedding started");
    }));
    await timedOut.promise;
    await Promise.resolve();
    expect(calls).toEqual(["chat started"]);
    network.resolve();
    await batch;
    expect(calls).toEqual(["chat started", "chat finished", "embedding started"]);
  });

  it("rejects unreserved local overrides inside a cloud-only batch", async () => {
    const coordinator = new ModelCoordinator();
    await expect(
      coordinator.batch(
        null,
        () => coordinator.request("chat", endpoint, async () => 1),
        async () => 2,
      ),
    ).rejects.toThrow("batch profiles");
  });
  it("holds a batch across both phases while unrelated embedding requests wait", async () => {
    const coordinator = new ModelCoordinator();
    const started = deferred();
    const proceed = deferred();
    const calls: string[] = [];
    const batch = coordinator.batch(
      "local-gpu",
      async () => {
        await coordinator.request("chat", endpoint, async () => {
          calls.push("chat 1");
        });
        started.resolve();
        await proceed.promise;
        await coordinator.request("chat", endpoint, async () => {
          calls.push("chat 2");
        });
      },
      async () =>
        coordinator.request("embedding", endpoint, async () => {
          calls.push("batch embedding");
        }),
    );
    await started.promise;
    const search = coordinator.request("embedding", endpoint, async () => {
      calls.push("search embedding");
    });
    await coordinator.request("chat", "https://cloud.invalid/v1", async () => {
      calls.push("remote chat");
    });
    expect(calls).toEqual(["chat 1", "remote chat"]);
    proceed.resolve();
    await Promise.all([batch, search]);
    expect(calls).toEqual([
      "chat 1",
      "remote chat",
      "chat 2",
      "batch embedding",
      "search embedding",
    ]);
  });

  it("propagates reservations into nested message handlers without reacquiring the GPU", async () => {
    const coordinator = new ModelCoordinator();
    const bus = new MessageBus();
    bus.handle("describe", () =>
      coordinator.phase("chat", () =>
        coordinator.request("chat", endpoint, async () => "description"),
      ),
    );
    const result = await coordinator.batch(
      "local-gpu",
      () => bus.request<string>("describe", {}),
      (description) =>
        coordinator.request(
          "embedding",
          endpoint,
          async () => `${description} embedded`,
        ),
    );
    expect(result).toBe("description embedded");
  });

  it("rejects phase violations and releases the reservation after failure", async () => {
    const coordinator = new ModelCoordinator();
    await expect(
      coordinator.batch(
        "local-gpu",
        () => coordinator.request("embedding", endpoint, async () => 1),
        async () => 2,
      ),
    ).rejects.toThrow("chat phase");
    expect(await coordinator.request("chat", endpoint, async () => 3)).toBe(3);
    await expect(
      coordinator.batch(
        "local-gpu",
        async () => 1,
        () => coordinator.request("chat", endpoint, async () => 2),
      ),
    ).rejects.toThrow("embedding phase");
  });

  it("keeps reservations until a detached in-flight request finishes", async () => {
    const coordinator = new ModelCoordinator();
    const network = deferred();
    const started = deferred();
    let request!: Promise<void>;
    const calls: string[] = [];
    const batch = coordinator.exclusive("local-gpu", async () => {
      request = coordinator.request("chat", endpoint, async () => {
        started.resolve();
        await network.promise;
        calls.push("request finished");
      });
      await started.promise;
    });
    await started.promise;
    const queued = coordinator.request("embedding", endpoint, async () => {
      calls.push("next request");
    });
    await Promise.resolve();
    expect(calls).toEqual([]);
    network.resolve();
    await Promise.all([batch, request, queued]);
    expect(calls).toEqual(["request finished", "next request"]);
  });
});
