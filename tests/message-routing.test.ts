import { describe, expect, it } from "bun:test";
import { MessageBus } from "../lib/messages";
import { ExtensionMessages } from "../sdk/messages";
import {
  createExtensionSDK,
  getSDK,
  runWithSDK,
  requestMessage,
  onMessage,
} from "../sdk";
import { ModelCoordinator } from "../lib/ai/scheduler";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("request lifecycle", () => {
  it("times out a stalled capability check and never dispatches it later", async () => {
    const bus = new MessageBus();
    const predicate = deferred<boolean>();
    let calls = 0;
    let signal: AbortSignal | undefined;
    bus.handle("slow", () => ++calls, {
      canHandle: (_, context) => {
        signal = context.signal;
        return predicate.promise;
      },
    });
    await expect(bus.request("slow", {}, { timeoutMs: 10 })).rejects.toThrow(
      "timed out",
    );
    expect(signal?.aborted).toBe(true);
    predicate.resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(0);
  });

  it("uses one deadline for selection and handler execution", async () => {
    const bus = new MessageBus();
    let signal: AbortSignal | undefined;
    bus.handle(
      "slow",
      (_, context) => {
        signal = context.signal;
        return new Promise(() => {});
      },
      {
        canHandle: async () => {
          await Bun.sleep(5);
          return true;
        },
      },
    );
    await expect(bus.request("slow", {}, { timeoutMs: 20 })).rejects.toThrow(
      "timed out",
    );
    expect(signal?.aborted).toBe(true);
  });

  it("honors cancellation before dispatch and during a predicate", async () => {
    const bus = new MessageBus();
    const gate = deferred<boolean>();
    let checks = 0;
    let calls = 0;
    bus.handle("cancel", () => ++calls, {
      canHandle: () => {
        checks++;
        return gate.promise;
      },
    });
    const prior = new AbortController();
    prior.abort(new Error("already cancelled"));
    await expect(
      bus.request("cancel", {}, { signal: prior.signal }),
    ).rejects.toThrow("already cancelled");
    expect(checks).toBe(0);
    const active = new AbortController();
    const request = bus.request(
      "cancel",
      {},
      { signal: active.signal, timeoutMs: 0 },
    );
    active.abort(new Error("cancel now"));
    await expect(request).rejects.toThrow("cancel now");
    gate.resolve(true);
    await Promise.resolve();
    expect(calls).toBe(0);
  });

  it("makes cancellation observable inside a running handler", async () => {
    const bus = new MessageBus();
    let cancelled = false;
    bus.handle(
      "cancel",
      (_, context) =>
        new Promise<void>((resolve) => {
          context.signal!.addEventListener(
            "abort",
            () => {
              cancelled = true;
              resolve();
            },
            { once: true },
          );
        }),
    );
    const controller = new AbortController();
    const request = bus.request("cancel", {}, { signal: controller.signal });
    controller.abort(new Error("sender stopped"));
    await expect(request).rejects.toThrow("sender stopped");
    expect(cancelled).toBe(true);
  });

  it("does not retry a failed selected handler", async () => {
    const bus = new MessageBus();
    let retries = 0;
    bus.handle(
      "write",
      () => {
        throw new Error("write failed");
      },
      { priority: 10 },
    );
    bus.handle("write", () => ++retries);
    await expect(bus.request("write", {})).rejects.toThrow("write failed");
    expect(retries).toBe(0);
  });

  it("keeps handler registration changes out of an active routing snapshot", async () => {
    const bus = new MessageBus();
    let checks = 0;
    bus.handle("route", () => "reject", {
      priority: 10,
      canHandle: () => {
        checks++;
        bus.handle("route", () => "new", { priority: 100 });
        return false;
      },
    });
    bus.handle("route", () => "original");
    expect(await bus.request<string>("route", {})).toBe("original");
    expect(checks).toBe(1);
    expect(await bus.request<string>("route", {})).toBe("new");
  });
});

describe("event and subscription ownership", () => {
  it("takes a listener snapshot before any listener can change registrations", async () => {
    const bus = new MessageBus();
    const calls: string[] = [];
    bus.on(
      "event",
      () => {
        calls.push("first");
        bus.on(
          "event",
          () => {
            calls.push("new");
          },
          { priority: 100 },
        );
        removeSecond();
      },
      { priority: 10 },
    );
    const removeSecond = bus.on("event", () => {
      calls.push("second");
    });
    await bus.publish("event", {});
    expect(calls).toEqual(["first", "second"]);
    calls.length = 0;
    await bus.publish("event", {});
    expect(calls).toEqual(["new", "first"]);
  });

  it("runs once only once when a higher-priority listener publishes recursively", async () => {
    const bus = new MessageBus();
    let nested: Promise<void> | undefined;
    let calls = 0;
    bus.on(
      "event",
      (depth: number) => {
        if (!depth) nested = bus.publish("event", 1);
      },
      { priority: 10 },
    );
    bus.once("event", () => {
      calls++;
    });
    await bus.publish("event", 0);
    await nested;
    expect(calls).toBe(1);
  });

  it("clears only this client's registrations and permits registering again", async () => {
    const bus = new MessageBus();
    const a = new ExtensionMessages("a", bus);
    const b = new ExtensionMessages("b", bus);
    let events = 0;
    a.handle("a", () => "a");
    a.on("event", () => {
      events += 100;
    });
    b.handle("b", () => "b");
    b.on("event", () => {
      events++;
    });
    a.clear();
    await b.publish("event", {});
    expect(events).toBe(1);
    expect(bus.hasHandler("a")).toBe(false);
    expect(await b.request<string>("b", {})).toBe("b");
    a.handle("a", () => "again");
    expect(await a.request<string>("a", {})).toBe("again");
    a.reset();
    expect(bus.hasHandler("a")).toBe(false);
    expect(bus.hasHandler("b")).toBe(true);
    b.dispose();
    expect(bus.getChannels()).toEqual([]);
  });

  it("a stale unsubscribe cannot remove a registration made after reset", async () => {
    const bus = new MessageBus();
    const old = bus.handle("test", () => "old");
    bus.reset();
    bus.handle("test", () => "new");
    old();
    old();
    expect(await bus.request<string>("test", {})).toBe("new");
  });

  it("delivers metadata snapshots and keeps SDK sender attribution", async () => {
    const bus = new MessageBus();
    const a = new ExtensionMessages("a", bus);
    const b = new ExtensionMessages("b", bus);
    const seen: unknown[] = [];
    b.handle("meta", (_, context) => {
      seen.push(context.senderId, context.metadata);
      expect(Object.isFrozen(context.metadata)).toBe(true);
      return "ok";
    });
    b.on("meta", (_, context) => {
      seen.push(context.senderId, context.metadata);
    });
    const metadata = { trace: "original" };
    const request = a.request("meta", {}, { metadata, senderId: "spoofed" });
    metadata.trace = "changed";
    await request;
    await a.publish("meta", {}, { metadata, senderId: "spoofed" });
    expect(seen).toEqual([
      "a",
      { trace: "original" },
      "a",
      { trace: "changed" },
    ]);
  });
});

describe("receiving SDK scope", () => {
  it("binds predicates, handlers, nested requests, and listeners to their owners", async () => {
    const bus = new MessageBus();
    const a = createExtensionSDK("a", { messageBus: bus });
    const b = createExtensionSDK("b", { messageBus: bus });
    const c = createExtensionSDK("c", { messageBus: bus });
    const seen: string[] = [];
    b.messages.handle(
      "outer",
      async (_, context) => {
        await Promise.resolve();
        seen.push(getSDK().extensionId, context.senderId!);
        await requestMessage("inner", {});
        seen.push(getSDK().extensionId);
      },
      {
        canHandle: async () => {
          await Promise.resolve();
          seen.push(getSDK().extensionId);
          return true;
        },
      },
    );
    c.messages.handle("inner", (_, context) => {
      seen.push(getSDK().extensionId, context.senderId!);
    });
    runWithSDK(b, () =>
      onMessage("event", async () => {
        await Promise.resolve();
        seen.push(getSDK().extensionId);
      }),
    );
    c.messages.once("event", () => {
      seen.push(getSDK().extensionId);
    });
    await runWithSDK(a, async () => {
      await requestMessage("outer", {});
      expect(getSDK()).toBe(a);
      await a.messages.publish("event", {});
      expect(getSDK()).toBe(a);
    });
    expect(seen.slice(0, 6)).toEqual(["b", "b", "a", "c", "b", "b"]);
    expect(seen.slice(6).sort()).toEqual(["b", "c"]);
  });

  it("changes SDK identity without losing GPU reservation or phase guards", async () => {
    const bus = new MessageBus();
    const a = createExtensionSDK("a", { messageBus: bus });
    const b = createExtensionSDK("b", { messageBus: bus });
    const coordinator = new ModelCoordinator();
    const endpoint = "http://localhost:11434/v1";
    b.messages.handle("chat", async () => {
      expect(getSDK()).toBe(b);
      await expect(
        coordinator.request("embedding", endpoint, async () => "invalid"),
      ).rejects.toThrow("chat phase");
      return coordinator.request("chat", endpoint, async () => "described");
    });
    const result = await runWithSDK(a, () =>
      coordinator.batch(
        "local-gpu",
        () => a.messages.request("chat", {}, { timeoutMs: 100 }),
        (text) =>
          coordinator.request(
            "embedding",
            endpoint,
            async () => `${text} embedded`,
          ),
      ),
    );
    expect(result).toBe("described embedded");
  });
});
