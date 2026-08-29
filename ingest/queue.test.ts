import { describe, expect, it } from "bun:test";
import { QueueManager } from "./queue";

describe("QueueManager", () => {
  it("processes items sequentially per handler and broadcasts to all handlers", async () => {
    const queue = new QueueManager<number>();

    const h1Log: { item: number; start: number; end: number }[] = [];
    const h2Log: { item: number; start: number; end: number }[] = [];

    // Handler 1: 50ms per item
    queue.addHandler(async (item) => {
      const start = Date.now();
      await new Promise((r) => setTimeout(r, 50));
      const end = Date.now();
      h1Log.push({ item, start, end });
    });

    // Handler 2: 10ms per item
    queue.addHandler(async (item) => {
      const start = Date.now();
      await new Promise((r) => setTimeout(r, 10));
      const end = Date.now();
      h2Log.push({ item, start, end });
    });

    queue.push(1);
    queue.push(2);
    queue.push(3);

    await queue.idle();

    expect(h1Log.map((x) => x.item)).toEqual([1, 2, 3]);
    expect(h2Log.map((x) => x.item)).toEqual([1, 2, 3]);

    // Verify sequential execution for handler 1
    for (let i = 1; i < h1Log.length; i++) {
      expect(h1Log[i].start).toBeGreaterThanOrEqual(h1Log[i - 1].end - 2);
    }

    // Verify sequential execution for handler 2
    for (let i = 1; i < h2Log.length; i++) {
      expect(h2Log[i].start).toBeGreaterThanOrEqual(h2Log[i - 1].end - 2);
    }
  });

  it("handles errors gracefully without stopping handler processing", async () => {
    const queue = new QueueManager<string>();
    const processed: string[] = [];
    const errors: string[] = [];

    queue.addHandler(
      async (item) => {
        if (item === "bad") {
          throw new Error("Failed");
        }
        processed.push(item);
      },
      {
        onError: (_err, item) => {
          errors.push(item);
        },
      }
    );

    queue.push("first");
    queue.push("bad");
    queue.push("third");

    await queue.idle();

    expect(processed).toEqual(["first", "third"]);
    expect(errors).toEqual(["bad"]);
  });

  it("supports unsubscribing handlers", async () => {
    const queue = new QueueManager<number>();
    const received: number[] = [];

    const unsubscribe = queue.addHandler((item) => {
      received.push(item);
    });

    queue.push(1);
    await queue.idle();

    unsubscribe();

    queue.push(2);
    await queue.idle();

    expect(received).toEqual([1]);
  });
});
