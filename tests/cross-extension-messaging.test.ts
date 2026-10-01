import { describe, expect, it, beforeEach } from "bun:test";
import {
  createMessageBus,
  defaultMessageBus,
  MessageBus,
} from "../lib/messages";
import {
  createExtensionSDK,
  requestMessage,
  sendMessage,
  publishMessage,
  handleMessage,
  onMessage,
  messages,
} from "../sdk";
import type {
  ProcessFileRequest,
  ProcessFileResponse,
  ProcessFilesBatchRequest,
  ProcessFilesBatchResponse,
  CanProcessFilesRequest,
  CanProcessFilesResponse,
  SourceIngestedEvent,
  LinkEntitiesRequest,
  SummarizeContentRequest,
  SummarizeContentBatchRequest,
  SummarizeContentBatchResponse,
  SystemBackupRequest,
  SearchQueryRequest,
} from "../lib/messages.types";

describe("Cross-Extension Messaging System", () => {
  let bus: MessageBus;

  beforeEach(() => {
    bus = createMessageBus();
    defaultMessageBus.reset();
  });

  describe("1. Arbitrary Request / Response Messaging", () => {
    it("routes arbitrary request to registered handler and returns response", async () => {
      const extA = createExtensionSDK("ext-caller", "ns-a", undefined, undefined, undefined, undefined, undefined, bus);
      const extB = createExtensionSDK("ext-provider", "ns-b", undefined, undefined, undefined, undefined, undefined, bus);

      extB.messages.handle("math:square", async (payload: { n: number }, ctx) => {
        expect(ctx.senderId).toBe("ext-caller");
        expect(ctx.channel).toBe("math:square");
        expect(ctx.messageId).toBeTruthy();
        expect(ctx.timestamp).toBeGreaterThan(0);
        return { result: payload.n * payload.n };
      });

      const response = await extA.messages.request<{ result: number }, { n: number }>(
        "math:square",
        { n: 7 },
      );

      expect(response.result).toBe(49);
    });

    it("supports send() alias for request()", async () => {
      const extA = createExtensionSDK("ext-a", "ns-a", undefined, undefined, undefined, undefined, undefined, bus);
      const extB = createExtensionSDK("ext-b", "ns-b", undefined, undefined, undefined, undefined, undefined, bus);

      extB.messages.handle("ping", async (payload: { msg: string }) => {
        return { pong: payload.msg };
      });

      const res = await extA.messages.send<{ pong: string }, { msg: string }>("ping", { msg: "hello" });
      expect(res.pong).toBe("hello");
    });

    it("throws a descriptive error if no handler is registered for the channel", async () => {
      const ext = createExtensionSDK("ext-caller", "ns", undefined, undefined, undefined, undefined, undefined, bus);

      expect(
        ext.messages.request("unhandled:channel", { foo: "bar" }),
      ).rejects.toThrow('No registered handler for channel "unhandled:channel"');
    });

    it("throws a timeout error if handler takes longer than timeoutMs", async () => {
      const extA = createExtensionSDK("ext-caller", "ns", undefined, undefined, undefined, undefined, undefined, bus);
      const extB = createExtensionSDK("ext-slow", "ns", undefined, undefined, undefined, undefined, undefined, bus);

      extB.messages.handle("slow:channel", async () => {
        await new Promise((r) => setTimeout(r, 100));
        return { done: true };
      });

      expect(
        extA.messages.request("slow:channel", {}, { timeoutMs: 20 }),
      ).rejects.toThrow('Request to channel "slow:channel" timed out after 20ms');
    });

    it("allows unsubscribing a request handler", async () => {
      const extA = createExtensionSDK("ext-caller", "ns", undefined, undefined, undefined, undefined, undefined, bus);
      const extB = createExtensionSDK("ext-provider", "ns", undefined, undefined, undefined, undefined, undefined, bus);

      const unsubscribe = extB.messages.handle("temp:channel", () => "ok");
      expect(extA.messages.hasHandler("temp:channel")).toBe(true);

      unsubscribe();
      expect(extA.messages.hasHandler("temp:channel")).toBe(false);

      expect(extA.messages.request("temp:channel", {})).rejects.toThrow("No registered handler");
    });
  });

  describe("2. Predicate Matchers, Priority Ordering & Target Routing", () => {
    it("evaluates canHandle predicate to select the appropriate handler", async () => {
      const extA = createExtensionSDK("caller", "ns", undefined, undefined, undefined, undefined, undefined, bus);
      const extB = createExtensionSDK("image-handler", "ns", undefined, undefined, undefined, undefined, undefined, bus);
      const extC = createExtensionSDK("text-handler", "ns", undefined, undefined, undefined, undefined, undefined, bus);

      extB.messages.handle(
        "file:test",
        async (payload: { ext: string }) => ({ handler: "image", file: payload.ext }),
        {
          name: "image-handler",
          canHandle: (payload) => payload.ext === "png" || payload.ext === "jpg",
        },
      );

      extC.messages.handle(
        "file:test",
        async (payload: { ext: string }) => ({ handler: "text", file: payload.ext }),
        {
          name: "text-handler",
          canHandle: (payload) => payload.ext === "txt" || payload.ext === "md",
        },
      );

      const resImage = await extA.messages.request<{ handler: string }>("file:test", { ext: "png" });
      expect(resImage.handler).toBe("image");

      const resText = await extA.messages.request<{ handler: string }>("file:test", { ext: "md" });
      expect(resText.handler).toBe("text");
    });

    it("routes by priority descending when multiple handlers accept request", async () => {
      const extA = createExtensionSDK("caller", "ns", undefined, undefined, undefined, undefined, undefined, bus);
      const extB = createExtensionSDK("low-priority", "ns", undefined, undefined, undefined, undefined, undefined, bus);
      const extC = createExtensionSDK("high-priority", "ns", undefined, undefined, undefined, undefined, undefined, bus);

      extB.messages.handle("priority:test", () => "low", { priority: 1 });
      extC.messages.handle("priority:test", () => "high", { priority: 100 });

      const res = await extA.messages.request<string>("priority:test", {});
      expect(res).toBe("high");
    });

    it("routes explicitly to target extension when target option is specified", async () => {
      const extA = createExtensionSDK("caller", "ns", undefined, undefined, undefined, undefined, undefined, bus);
      const extB = createExtensionSDK("worker-alpha", "ns", undefined, undefined, undefined, undefined, undefined, bus);
      const extC = createExtensionSDK("worker-beta", "ns", undefined, undefined, undefined, undefined, undefined, bus);

      extB.messages.handle("work:execute", () => ({ worker: "alpha" }), { name: "worker-alpha" });
      extC.messages.handle("work:execute", () => ({ worker: "beta" }), { name: "worker-beta" });

      const resBeta = await extA.messages.request<{ worker: string }>("work:execute", {}, { target: "worker-beta" });
      expect(resBeta.worker).toBe("beta");

      const resAlpha = await extA.messages.request<{ worker: string }>("work:execute", {}, { target: "worker-alpha" });
      expect(resAlpha.worker).toBe("alpha");
    });
  });

  describe("3. Publish / Subscribe Event Broadcasting", () => {
    it("broadcasts events to all registered listeners concurrently", async () => {
      const extA = createExtensionSDK("publisher", "ns", undefined, undefined, undefined, undefined, undefined, bus);
      const extB = createExtensionSDK("sub-1", "ns", undefined, undefined, undefined, undefined, undefined, bus);
      const extC = createExtensionSDK("sub-2", "ns", undefined, undefined, undefined, undefined, undefined, bus);

      let sub1Received: any = null;
      let sub2Received: any = null;

      extB.messages.on("alert:trigger", (payload, ctx) => {
        expect(ctx.senderId).toBe("publisher");
        sub1Received = payload;
      });

      extC.messages.on("alert:trigger", (payload) => {
        sub2Received = payload;
      });

      await extA.messages.publish("alert:trigger", { level: "warning", message: "disk full" });

      expect(sub1Received).toEqual({ level: "warning", message: "disk full" });
      expect(sub2Received).toEqual({ level: "warning", message: "disk full" });
    });

    it("supports once() for single event consumption", async () => {
      const extA = createExtensionSDK("pub", "ns", undefined, undefined, undefined, undefined, undefined, bus);
      const extB = createExtensionSDK("sub", "ns", undefined, undefined, undefined, undefined, undefined, bus);

      let count = 0;
      extB.messages.once("one-time:event", () => {
        count++;
      });

      await extA.messages.publish("one-time:event", { n: 1 });
      await extA.messages.publish("one-time:event", { n: 2 });

      expect(count).toBe(1);
    });

    it("isolates errors in event listeners so failing listeners do not break others", async () => {
      const extA = createExtensionSDK("pub", "ns", undefined, undefined, undefined, undefined, undefined, bus);
      const extB = createExtensionSDK("bad-sub", "ns", undefined, undefined, undefined, undefined, undefined, bus);
      const extC = createExtensionSDK("good-sub", "ns", undefined, undefined, undefined, undefined, undefined, bus);

      let goodReceived = false;

      extB.messages.on("event:test", () => {
        throw new Error("listener boom!");
      });

      extC.messages.on("event:test", () => {
        goodReceived = true;
      });

      await extA.messages.publish("event:test", {});
      expect(goodReceived).toBe(true);
    });
  });

  describe("4. Built-in Type-Safe Channels", () => {
    it("implements file:process channel with type safety", async () => {
      const extA = createExtensionSDK("obsidian", "obsidian", undefined, undefined, undefined, undefined, undefined, bus);
      const extB = createExtensionSDK("file-proc", "proc", undefined, undefined, undefined, undefined, undefined, bus);

      extB.messages.handle("file:process", async (req: ProcessFileRequest): Promise<ProcessFileResponse> => {
        return {
          success: true,
          filePath: req.filePath ?? "",
          fileType: req.fileType ?? "image",
          title: "diagram.png",
          uri: `file://${req.filePath}`,
          description: "System diagram showing microservices",
          chunks: [
            {
              chunk_index: 0,
              text_content: "System diagram showing microservices",
              embedding: [0.1, 0.2, 0.3],
            },
          ],
          entities: [{ name: "diagram.png", type: "Image" }],
          edges: [
            {
              source: "diagram.png",
              target: req.contextEntity ?? "Vault",
              relation: "IN_SAME_VAULT",
            },
          ],
        };
      });

      // Type checking: request automatically knows input is ProcessFileRequest and output is ProcessFileResponse
      const response = await extA.messages.request("file:process", {
        filePath: "/vault/diagram.png",
        fileType: "image",
        contextEntity: "MainVault",
      });

      expect(response.success).toBe(true);
      expect(response.title).toBe("diagram.png");
      expect(response.chunks.length).toBe(1);
      expect(response.chunks[0].embedding).toEqual([0.1, 0.2, 0.3]);
      expect(response.entities[0].name).toBe("diagram.png");
      expect(response.edges[0].relation).toBe("IN_SAME_VAULT");
    });

    it("implements file:can-process channel", async () => {
      const extA = createExtensionSDK("caller", "ns", undefined, undefined, undefined, undefined, undefined, bus);
      const extB = createExtensionSDK("pdf-proc", "ns", undefined, undefined, undefined, undefined, undefined, bus);

      extB.messages.handle("file:can-process", async (req) => {
        return {
          canProcess: req.filePath.endsWith(".pdf"),
          supportedBy: "pdf-proc",
        };
      });

      const checkPdf = await extA.messages.request("file:can-process", { filePath: "paper.pdf" });
      expect(checkPdf.canProcess).toBe(true);
      expect(checkPdf.supportedBy).toBe("pdf-proc");

      const checkPng = await extA.messages.request("file:can-process", { filePath: "pic.png" });
      expect(checkPng.canProcess).toBe(false);
    });

    it("implements files:process bulk channel with type safety", async () => {
      const extA = createExtensionSDK("caller", "ns", undefined, undefined, undefined, undefined, undefined, bus);
      const extB = createExtensionSDK("batch-processor", "ns", undefined, undefined, undefined, undefined, undefined, bus);

      extB.messages.handle("files:process", async (req: ProcessFilesBatchRequest): Promise<ProcessFilesBatchResponse> => {
        const filePaths = req.filePaths || [];
        return {
          success: true,
          totalProcessed: filePaths.length,
          totalFailed: 0,
          results: filePaths.map((fp) => ({
            success: true,
            filePath: fp,
            fileType: "markdown",
            title: fp.split("/").pop() || fp,
            uri: `file://${fp}`,
            chunks: [
              {
                chunk_index: 0,
                chunk_type: "verbatim",
                text_content: `Content of ${fp}`,
              },
            ],
            entities: [],
            edges: [],
          })),
        };
      });

      const response = await extA.messages.request("files:process", {
        filePaths: ["/vault/doc1.md", "/vault/doc2.md"],
        options: { deferEmbedding: true },
      });

      expect(response.success).toBe(true);
      expect(response.totalProcessed).toBe(2);
      expect(response.results.length).toBe(2);
      expect(response.results[0].title).toBe("doc1.md");
      expect(response.results[0].chunks[0].chunk_type).toBe("verbatim");
      expect(response.results[1].title).toBe("doc2.md");
    });

    it("implements files:can-process bulk capability channel", async () => {
      const extA = createExtensionSDK("caller", "ns", undefined, undefined, undefined, undefined, undefined, bus);
      const extB = createExtensionSDK("pdf-proc", "ns", undefined, undefined, undefined, undefined, undefined, bus);

      extB.messages.handle("files:can-process", async (req: CanProcessFilesRequest): Promise<CanProcessFilesResponse> => {
        const results: Record<string, any> = {};
        let all = true;
        for (const fp of req.filePaths) {
          const can = fp.endsWith(".pdf");
          results[fp] = { canProcess: can, supportedBy: can ? "pdf-proc" : undefined };
          if (!can) all = false;
        }
        return { canProcessAll: all, results };
      });

      const res = await extA.messages.request("files:can-process", {
        filePaths: ["doc1.pdf", "doc2.pdf", "image.png"],
      });

      expect(res.canProcessAll).toBe(false);
      expect(res.results["doc1.pdf"].canProcess).toBe(true);
      expect(res.results["image.png"].canProcess).toBe(false);
    });

    it("implements source:ingested event channel", async () => {
      const extA = createExtensionSDK("ingestor", "ns", undefined, undefined, undefined, undefined, undefined, bus);
      const extB = createExtensionSDK("listener", "ns", undefined, undefined, undefined, undefined, undefined, bus);

      const ingestedEvents: SourceIngestedEvent[] = [];
      extB.messages.on("source:ingested", (evt) => {
        ingestedEvents.push(evt);
      });

      await extA.messages.publish("source:ingested", {
        sourceId: "src-123",
        type: "markdown_note",
        uri: "file:///note.md",
        title: "Test Note",
        origin: "obsidian",
        chunksCount: 3,
        timestamp: Date.now(),
      });

      expect(ingestedEvents).toHaveLength(1);
      expect(ingestedEvents[0]?.sourceId).toBe("src-123");
      expect(ingestedEvents[0]?.origin).toBe("obsidian");
    });

    it("implements graph:link-entities request channel", async () => {
      const extA = createExtensionSDK("caller", "ns", undefined, undefined, undefined, undefined, undefined, bus);
      const extB = createExtensionSDK("graph-service", "ns", undefined, undefined, undefined, undefined, undefined, bus);

      extB.messages.handle("graph:link-entities", async (req: LinkEntitiesRequest) => {
        return {
          success: true,
          edgesCreated: 1,
        };
      });

      const res = await extA.messages.request("graph:link-entities", {
        sourceEntity: "Alice",
        targetEntity: "ProjectX",
        relation: "LEADS",
      });

      expect(res.success).toBe(true);
      expect(res.edgesCreated).toBe(1);
    });

    it("implements content:summarize request channel", async () => {
      const extA = createExtensionSDK("caller", "ns", undefined, undefined, undefined, undefined, undefined, bus);
      const extB = createExtensionSDK("ai-summarizer", "ns", undefined, undefined, undefined, undefined, undefined, bus);

      extB.messages.handle("content:summarize", async (req: SummarizeContentRequest) => {
        return {
          success: true,
          summary: `Summary of ${req.title ?? "content"}: ${req.content.slice(0, 20)}...`,
          keyPoints: ["Point A", "Point B"],
        };
      });

      const res = await extA.messages.request("content:summarize", {
        content: "Long text content detailing software architecture patterns and practices.",
        title: "Architecture Guide",
      });

      expect(res.success).toBe(true);
      expect(res.summary).toContain("Summary of Architecture Guide");
      expect(res.keyPoints?.length).toBe(2);
    });

    it("implements content:summarize-batch bulk request channel", async () => {
      const extA = createExtensionSDK("caller", "ns", undefined, undefined, undefined, undefined, undefined, bus);
      const extB = createExtensionSDK("ai-summarizer", "ns", undefined, undefined, undefined, undefined, undefined, bus);

      extB.messages.handle("content:summarize-batch", async (req: SummarizeContentBatchRequest): Promise<SummarizeContentBatchResponse> => {
        const contents = req.contents || req.items?.map((i) => i.content) || [];
        return {
          success: true,
          totalProcessed: contents.length,
          results: contents.map((c, i) => ({
            id: req.items?.[i]?.id,
            success: true,
            summary: `Brief: ${c.slice(0, 15)}`,
          })),
        };
      });

      const res = await extA.messages.request("content:summarize-batch", {
        items: [
          { id: "1", content: "First document on distributed systems" },
          { id: "2", content: "Second document on database replication" },
        ],
      });

      expect(res.success).toBe(true);
      expect(res.totalProcessed).toBe(2);
      expect(res.results[0].id).toBe("1");
      expect(res.results[0].summary).toContain("First document");
      expect(res.results[1].id).toBe("2");
      expect(res.results[1].summary).toContain("Second document");
    });

    it("implements system:backup request channel", async () => {
      const extA = createExtensionSDK("caller", "ns", undefined, undefined, undefined, undefined, undefined, bus);
      const extB = createExtensionSDK("db-backup", "ns", undefined, undefined, undefined, undefined, undefined, bus);

      extB.messages.handle("system:backup", async (req: SystemBackupRequest) => {
        return {
          success: true,
          backupPath: "/tmp/backup.db",
          sizeBytes: 1024,
        };
      });

      const res = await extA.messages.request("system:backup", { reason: "pre-upgrade" });
      expect(res.success).toBe(true);
      expect(res.backupPath).toBe("/tmp/backup.db");
    });

    it("implements search:query request channel", async () => {
      const extA = createExtensionSDK("caller", "ns", undefined, undefined, undefined, undefined, undefined, bus);
      const extB = createExtensionSDK("search-service", "ns", undefined, undefined, undefined, undefined, undefined, bus);

      extB.messages.handle("search:query", async (req: SearchQueryRequest) => {
        return {
          results: [
            {
              id: 1,
              sourceId: "src-1",
              title: "Result Title",
              textContent: "Matching snippet",
              score: 0.95,
            },
          ],
        };
      });

      const res = await extA.messages.request("search:query", { query: "vector search" });
      expect(res.results.length).toBe(1);
      expect(res.results[0].score).toBe(0.95);
    });
  });

  describe("5. Top-Level Convenience Functions & Dynamic Proxies", () => {
    it("supports top-level handleMessage and requestMessage on default bus", async () => {
      handleMessage("global:ping", (payload: { val: number }) => ({ doubled: payload.val * 2 }));

      const res = await requestMessage<{ doubled: number }, { val: number }>("global:ping", { val: 21 });
      expect(res.doubled).toBe(42);
    });

    it("supports top-level onMessage and publishMessage on default bus", async () => {
      let eventPayload: any = null;
      onMessage("global:event", (p) => {
        eventPayload = p;
      });

      await publishMessage("global:event", { status: "ready" });
      expect(eventPayload).toEqual({ status: "ready" });
    });

    it("delegates to active SDK through messages proxy", async () => {
      const ext = createExtensionSDK("proxy-test", "ns");
      expect(ext.messages).toBeDefined();
      expect(typeof ext.messages.request).toBe("function");
      expect(typeof ext.messages.publish).toBe("function");
      expect(typeof ext.messages.handle).toBe("function");
      expect(typeof ext.messages.on).toBe("function");
    });
  });
});
