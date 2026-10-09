import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShaleSDK } from "../../sdk";
import type { ClaimStatus } from "../../sdk/graph/types";
import { resolveEntityId, formatToolResponse, formatToolError } from "../types";

const ClaimStatusEnum = z.enum([
  "proposed",
  "accepted",
  "rejected",
  "disputed",
  "stale",
  "retracted",
  "superseded",
]);

export function registerSearchTools(mcp: McpServer, sdk: ShaleSDK) {
  const graph = sdk.graph;

  // ==========================================
  // 1. Search & Traversal Tools
  // ==========================================

  mcp.tool(
    "search_graph",
    "Searches the knowledge graph and source text chunks using BM25 retrieval, returning matching chunks expanded with their graph neighborhoods and evidence.",
    {
      query: z.string().describe("Search query text or keywords"),
      mode: z
        .enum(["bm25"])
        .default("bm25")
        .describe("Full-text retrieval mode"),
      limit: z.number().int().min(1).max(100).default(10).describe("Maximum chunks to return"),
      maxSeeds: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(5)
        .describe("Maximum chunks to expand into graph neighborhoods"),
      maxDepth: z.number().int().min(1).max(5).default(2).describe("Neighborhood traversal depth"),
      maxNeighbors: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Maximum neighbor entities to include per seed"),
      minScore: z.number().min(0).default(0.01).describe("Minimum chunk search score threshold"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (args) => {
      try {
        const results = await sdk.search.graph({
          query: args.query,
          mode: args.mode,
          limit: args.limit,
          maxSeeds: args.maxSeeds,
          minScore: args.minScore,
          graph: {
            maxDepth: args.maxDepth,
            maxNodes: args.maxNeighbors,
          },
        });
        return formatToolResponse(results);
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  mcp.tool(
    "traverse_graph",
    "Performs a bounded breadth-first traversal starting from an entity, exploring connected claims and entities.",
    {
      start: z
        .union([z.number().int(), z.string()])
        .describe("Start entity numeric ID or entity name"),
      maxDepth: z
        .number()
        .int()
        .min(1)
        .max(8)
        .default(2)
        .describe("Maximum traversal depth (default: 2)"),
      maxNodes: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe("Maximum nodes to retain (default: 100)"),
      maxClaims: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(200)
        .describe("Maximum claims to examine (default: 200)"),
      direction: z
        .enum(["out", "in", "both"])
        .default("both")
        .describe("Direction of edges to follow: out, in, or both"),
      predicates: z
        .array(z.string())
        .optional()
        .describe("Optional filter by predicate names"),
      context: z.string().optional().describe("Optional context scope filter"),
      statuses: z
        .array(ClaimStatusEnum)
        .optional()
        .describe("Allowed claim statuses (defaults to accepted)"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (args) => {
      try {
        const startId = resolveEntityId(sdk, args.start, "start entity");
        const result = graph.query.traverse({
          start: startId,
          maxDepth: args.maxDepth,
          maxNodes: args.maxNodes,
          maxClaims: args.maxClaims,
          direction: args.direction,
          predicates: args.predicates,
          context: args.context,
          statuses: args.statuses as ClaimStatus[] | undefined,
        });
        return formatToolResponse(result);
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  mcp.tool(
    "find_path",
    "Finds the shortest directed or undirected path between two entities in the knowledge graph.",
    {
      start: z
        .union([z.number().int(), z.string()])
        .describe("Start entity numeric ID or entity name"),
      target: z
        .union([z.number().int(), z.string()])
        .describe("Target entity numeric ID or entity name"),
      maxDepth: z
        .number()
        .int()
        .min(1)
        .max(8)
        .default(4)
        .describe("Maximum search depth"),
      direction: z
        .enum(["out", "in", "both"])
        .default("both")
        .describe("Edge direction: out, in, or both"),
      predicates: z
        .array(z.string())
        .optional()
        .describe("Optional filter by allowed predicate names"),
      context: z.string().optional().describe("Optional context scope"),
      statuses: z
        .array(ClaimStatusEnum)
        .optional()
        .describe("Allowed claim statuses (default: accepted)"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (args) => {
      try {
        const startId = resolveEntityId(sdk, args.start, "start entity");
        const targetId = resolveEntityId(sdk, args.target, "target entity");
        const result = graph.query.path({
          start: startId,
          target: targetId,
          maxDepth: args.maxDepth,
          direction: args.direction,
          predicates: args.predicates,
          context: args.context,
          statuses: args.statuses as ClaimStatus[] | undefined,
        });
        return formatToolResponse(result);
      } catch (err) {
        return formatToolError(err);
      }
    },
  );
}
