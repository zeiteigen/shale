import { z } from "zod";
import { auditContext, recordToolMutation } from "./audit";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShaleSDK } from "../../sdk";
import { formatToolResponse, formatToolError } from "../types";

export function registerRelationsTools(mcp: McpServer, sdk: ShaleSDK) {
  const graph = sdk.graph;

  // ==========================================
  // 4. Relations & Schema Tools
  // ==========================================

  mcp.tool(
    "list_relations",
    "Lists declared relation definitions, symmetry, transitivity, and constraints in the knowledge graph.",
    {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async () => {
      try {
        const rows = sdk.database
          .query<{ name: string; definition: string }, []>(
            "SELECT name, definition FROM graph_relations ORDER BY name",
          )
          .all();
        const relations = rows.map((r) => JSON.parse(r.definition));
        return formatToolResponse({ count: relations.length, relations });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  mcp.tool(
    "define_relation",
    "Declares a relation schema rule, setting symmetry, transitivity, allowed source/target entity types, or inverse relations.",
    {
      name: z.string().describe("Predicate name (e.g. PARENT_OF, SUBSIDIARY_OF)"),
      description: z.string().optional().describe("Human-readable explanation of the relation"),
      inverse: z.string().optional().describe("Name of the inverse predicate (e.g. CHILD_OF)"),
      symmetric: z.boolean().optional().describe("True if relation is bidirectional (e.g. SPOUSE_OF, PEER_OF)"),
      transitive: z.boolean().optional().describe("True if relation is transitive (e.g. PART_OF, LOCATED_IN)"),
      maxTargets: z.number().int().min(1).optional().describe("Maximum allowed active targets per subject"),
      sourceTypes: z.array(z.string()).optional().describe("Allowed entity types for subject"),
      targetTypes: z.array(z.string()).optional().describe("Allowed entity types for object"),
      ...auditContext("Define a relation schema via MCP"),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async (args) => {
      try {
        return formatToolResponse(recordToolMutation(sdk, "define_relation", args, (args) => {
          graph.relations.define({
            name: args.name,
            description: args.description,
            inverse: args.inverse,
            symmetric: args.symmetric,
            transitive: args.transitive,
            maxTargets: args.maxTargets,
            sourceTypes: args.sourceTypes,
            targetTypes: args.targetTypes,
          });
          return ({
            success: true,
            message: `Defined relation schema for "${args.name}"`,
          });
        }));
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  mcp.tool(
    "infer_transitive",
    "Derives transitive closure claims across declared transitive relations (e.g. A part-of B and B part-of C implies A part-of C).",
    {
      predicate: z.string().describe("Transitive predicate to infer"),
      namespace: z.string().optional().describe("Namespace filter (defaults to current namespace)"),
      context: z.string().optional().describe("Context scope filter (defaults to all)"),
      limit: z.number().int().min(1).max(1000).default(100).describe("Maximum derivations to produce"),
      ...auditContext("Infer transitive claims via MCP"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (args) => {
      try {
        return formatToolResponse(recordToolMutation(sdk, "infer_transitive", args, ({ predicate, namespace, context, limit }) => {
          const ns = namespace || (sdk as any).namespace || "knowledge";
          const result = graph.inference.transitive(predicate, ns, context ?? "", limit);
          return ({
            count: result.claimIds.length,
            claimIds: result.claimIds,
            truncated: result.truncated,
          });
        }));
      } catch (err) {
        return formatToolError(err);
      }
    },
  );
}
