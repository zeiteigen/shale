import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import {
  getEmbedding,
  getEmbeddings,
  resolveEmbeddingEndpoint,
  normalizeVectorDimensions,
  type FetchFn,
} from "../lib/ai";
import { embed, createExtensionSDK } from "../sdk";

describe("OpenAI-Compatible Embedding Functionality", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("Endpoint Resolution", () => {
    it("resolves default endpoint when no env variables are set", () => {
      delete process.env.OPENAI_BASE_URL;
      delete process.env.OPENAI_ENDPOINT;
      delete process.env.EMBEDDING_BASE_URL;
      delete process.env.EMBEDDING_ENDPOINT;

      expect(resolveEmbeddingEndpoint()).toBe(
        "https://api.openai.com/v1/embeddings",
      );
    });

    it("appends /embeddings to OPENAI_BASE_URL without trailing slash", () => {
      process.env.OPENAI_BASE_URL = "http://localhost:11434/v1";
      expect(resolveEmbeddingEndpoint()).toBe(
        "http://localhost:11434/v1/embeddings",
      );
    });

    it("handles trailing slashes on OPENAI_BASE_URL", () => {
      process.env.OPENAI_BASE_URL = "https://custom.ai/v1/";
      expect(resolveEmbeddingEndpoint()).toBe(
        "https://custom.ai/v1/embeddings",
      );
    });

    it("respects explicit OPENAI_ENDPOINT override", () => {
      process.env.OPENAI_ENDPOINT =
        "https://azure-openai.resource/deployments/embed/embeddings?api-version=2024-02";
      expect(resolveEmbeddingEndpoint()).toBe(
        "https://azure-openai.resource/deployments/embed/embeddings?api-version=2024-02",
      );
    });
  });

  describe("Dimension Normalization", () => {
    it("pads vectors to 4096 dimensions with zeros", () => {
      const input = [0.1, 0.2, 0.3];
      const normalized = normalizeVectorDimensions(input, 4096);

      expect(normalized.length).toBe(4096);
      expect(normalized[0]).toBeCloseTo(0.1);
      expect(normalized[1]).toBeCloseTo(0.2);
      expect(normalized[2]).toBeCloseTo(0.3);
      expect(normalized[3]).toBe(0);
      expect(normalized[4095]).toBe(0);
    });

    it("keeps vector unchanged if already matching target dimension", () => {
      const input = new Array(4096).fill(0.5);
      const normalized = normalizeVectorDimensions(input, 4096);

      expect(normalized.length).toBe(4096);
      expect(normalized).toBe(input); // exact reference
    });
  });

  describe("API Calling & Mock Handling", () => {
    it("calls endpoint with correct headers and payload, returning sorted embeddings", async () => {
      let interceptedUrl = "";
      let interceptedHeaders: any = {};
      let interceptedBody: any = {};

      const mockFetch: FetchFn = async (url, init) => {
        interceptedUrl = url.toString();
        interceptedHeaders = init?.headers;
        interceptedBody = JSON.parse(init?.body as string);

        return new Response(
          JSON.stringify({
            object: "list",
            data: [
              { object: "embedding", index: 1, embedding: [0.3, 0.4] },
              { object: "embedding", index: 0, embedding: [0.1, 0.2] },
            ],
            model: interceptedBody.model,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      process.env.OPENAI_API_KEY = "sk-test-12345";
      process.env.OPENAI_BASE_URL = "https://mock-openai.com/v1";
      delete process.env.OPENAI_EMBEDDING_MODEL;
      delete process.env.EMBEDDING_MODEL;

      const results = await getEmbeddings(["first", "second"], {
        fetchFn: mockFetch,
        padToDimensions: 4,
      });

      expect(interceptedUrl).toBe("https://mock-openai.com/v1/embeddings");
      expect(new Headers(interceptedHeaders).get("Authorization")).toBe(
        "Bearer sk-test-12345",
      );
      expect(interceptedBody.input).toEqual(["first", "second"]);
      expect(interceptedBody.model).toBe("text-embedding-3-small");

      // Sorted by index
      expect(results.length).toBe(2);
      expect(results[0][0]).toBeCloseTo(0.1);
      expect(results[0][1]).toBeCloseTo(0.2);
      expect(results[1][0]).toBeCloseTo(0.3);
      expect(results[1][1]).toBeCloseTo(0.4);
      // Padded to 4
      expect(results[0].length).toBe(4);
      expect(results[1].length).toBe(4);
    });

    it("throws descriptive error when API returns non-200", async () => {
      const mockFetch: FetchFn = async () => {
        return new Response(
          JSON.stringify({
            error: { message: "Invalid API key provided." },
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      };

      expect(
        getEmbedding("test text", {
          fetchFn: mockFetch,
          apiKey: "bad-key",
        }),
      ).rejects.toThrow(/OpenAI Embedding API error \(HTTP 401/);
    });
  });

  describe("SDK Embedder Integration", () => {
    it("provides embed and embedBatch via ShaleSDK", async () => {
      const mockFetch: FetchFn = async (_url, init) => {
        const body = JSON.parse(init?.body as string);
        const inputs = body.input as string[];

        return new Response(
          JSON.stringify({
            object: "list",
            data: inputs.map((_, i) => ({
              object: "embedding",
              index: i,
              embedding: [0.1 * (i + 1), 0.2 * (i + 1)],
            })),
            model: "text-embedding-3-small",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const sdk = createExtensionSDK("test-ext");

      // Single string returns number[]
      const single = await sdk.embed("Hello world", {
        fetchFn: mockFetch,
        padToDimensions: 4096,
      });
      expect(Array.isArray(single)).toBe(true);
      expect(single.length).toBe(4096);
      expect(single[0]).toBeCloseTo(0.1);

      // Multiple strings return number[][]
      const batch = await sdk.embed(["one", "two"], {
        fetchFn: mockFetch,
        padToDimensions: 4096,
      });
      expect(batch.length).toBe(2);
      expect(batch[0].length).toBe(4096);
      expect(batch[1].length).toBe(4096);
      expect(batch[0][0]).toBeCloseTo(0.1);
      expect(batch[1][0]).toBeCloseTo(0.2);

      // Standalone embed export
      const standalone = await embed("Standalone test", {
        fetchFn: mockFetch,
        padToDimensions: 4096,
      });
      expect(standalone.length).toBe(4096);
    });

    it("can insert SDK-generated embeddings directly into sqlite-vec vector_index", async () => {
      const db = new Database(":memory:");
      sqliteVec.load(db);
      db.run(
        "CREATE VIRTUAL TABLE vector_index USING vec0(embedding float[4096]);",
      );

      const mockFetch: FetchFn = async () => {
        return new Response(
          JSON.stringify({
            object: "list",
            data: [
              {
                object: "embedding",
                index: 0,
                embedding: new Array(1536).fill(0.02),
              },
            ],
            model: "text-embedding-3-small",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      };

      const embedding = await embed("Database test", {
        fetchFn: mockFetch,
        padToDimensions: 4096,
      });

      const buffer = new Uint8Array(new Float32Array(embedding).buffer);
      db.run("INSERT INTO vector_index (rowid, embedding) VALUES (1, ?);", [
        buffer,
      ]);

      const count = db
        .query<{ c: number }, []>("SELECT count(*) as c FROM vector_index")
        .get()!.c;
      expect(count).toBe(1);

      const match = db
        .query<
          {
            rowid: number;
            distance: number;
          },
          [Uint8Array]
        >(
          "SELECT rowid, distance FROM vector_index WHERE embedding MATCH ? AND k = 1",
        )
        .get(buffer);

      expect(match?.rowid).toBe(1);
      expect(match?.distance).toBeCloseTo(0);
    });

    it("creates an OpenAI instance via createOpenAIClient and exposes client on EmbedderClient", async () => {
      const { createOpenAIClient } = await import("../lib/ai");
      const { EmbedderClient } = await import("../sdk/embed");
      const { default: OpenAI } = await import("openai");

      const client = createOpenAIClient({
        apiKey: "test-sk",
        baseUrl: "https://test.api.com/v1",
      });
      expect(client).toBeInstanceOf(OpenAI);
      expect(client.baseURL).toBe("https://test.api.com/v1");

      const embedder = new EmbedderClient({ apiKey: "test-sk-2" });
      expect(embedder.client).toBeInstanceOf(OpenAI);

      // Instantiating with an existing OpenAI client
      const customClient = new OpenAI({ apiKey: "custom-sk" });
      const embedderWithCustom = new EmbedderClient(customClient);
      expect(embedderWithCustom.client).toBe(customClient);
    });
  });
});
