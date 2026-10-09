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
  it("drains timed-out message requests before finalizing a chat batch", async () => {
    const coordinator = new ModelCoordinator();
    const bus = new MessageBus();
    const network = deferred();
    const timedOut = deferred();
    const calls: string[] = [];
    bus.handle("slow-vision", () => coordinator.request( endpoint, async () => {
      calls.push("chat started");
      await network.promise;
      calls.push("chat finished");
    }));
    const batch = coordinator.batch("local-gpu", async () => {
      await expect(bus.request("slow-vision", {}, { timeoutMs: 5 })).rejects.toThrow("timed out");
      timedOut.resolve();
    }, () => coordinator.request( endpoint, async () => {
      calls.push("finalize started");
    }));
    await timedOut.promise;
    await Promise.resolve();
    expect(calls).toEqual(["chat started"]);
    network.resolve();
    await batch;
    expect(calls).toEqual(["chat started", "chat finished", "finalize started"]);
  });

  it("schedules a local override inside a cloud-only batch", async () => {
    const coordinator = new ModelCoordinator();
    const result = await coordinator.batch(null,
      () => coordinator.request( endpoint, async () => 1),
      async prepared => prepared + 1);
    expect(result).toBe(2);
  });
  it("holds a chat batch reservation through finalization while unrelated local requests wait", async () => {
    const coordinator = new ModelCoordinator();
    const started = deferred();
    const proceed = deferred();
    const calls: string[] = [];
    const batch = coordinator.batch(
      "local-gpu",
      async () => {
        await coordinator.request( endpoint, async () => {
          calls.push("chat 1");
        });
        started.resolve();
        await proceed.promise;
        await coordinator.request( endpoint, async () => { calls.push("chat 2"); });
      },
      async () =>
        coordinator.request( endpoint, async () => {
          calls.push("batch finalize");
        }),
    );
    await started.promise;
    const nextLocal = coordinator.request( endpoint, async () => {
      calls.push("next local request");
    });
    await coordinator.request( "https://cloud.invalid/v1", async () => {
      calls.push("remote chat");
    });
    expect(calls).toEqual(["chat 1", "remote chat"]);
    proceed.resolve();
    await Promise.all([batch, nextLocal]);
    expect(calls).toEqual([
      "chat 1",
      "remote chat",
      "chat 2",
      "batch finalize",
      "next local request",
    ]);
  });

  it("propagates reservations into nested message handlers without reacquiring the GPU", async () => {
    const coordinator = new ModelCoordinator();
    const bus = new MessageBus();
    bus.handle("describe", () =>
      coordinator.request( endpoint, async () => "description"),
    );
    const result = await coordinator.batch(
      "local-gpu",
      () => bus.request<string>("describe", {}),
      (description) => coordinator.request( endpoint, async () => `${description} finalized`),
    );
    expect(result).toBe("description finalized");
  });

  it("keeps reservations until a detached in-flight request finishes", async () => {
    const coordinator = new ModelCoordinator();
    const network = deferred();
    const started = deferred();
    let request!: Promise<void>;
    const calls: string[] = [];
    const batch = coordinator.exclusive("local-gpu", async () => {
      request = coordinator.request( endpoint, async () => {
        started.resolve();
        await network.promise;
        calls.push("request finished");
      });
      await started.promise;
    });
    await started.promise;
    const queued = coordinator.request( endpoint, async () => {
      calls.push("next request");
    });
    await Promise.resolve();
    expect(calls).toEqual([]);
    network.resolve();
    await Promise.all([batch, request, queued]);
    expect(calls).toEqual(["request finished", "next request"]);
  });
});
