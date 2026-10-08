import { z } from "zod";
import { claimInput } from "../../sdk/knowledge/schemas";
import { auditContext, recordToolMutation } from "./audit";
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

export function registerClaimsTools(mcp: McpServer, sdk: ShaleSDK) {
  const graph = sdk.graph;

  // ==========================================
  // 3. Claims & Assertions Tools
  // ==========================================

  mcp.tool(
    "get_claim",
    "Retrieves a single claim by its unique ID.",
    {
      id: z.string().describe("UUID of the claim"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ id }) => {
      try {
        const claim = graph.claims.get(id);
        return formatToolResponse(claim);
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  mcp.tool(
    "list_claims",
    "Queries claims matching entity, subject, predicate, object, context, or status filters.",
    {
      entityId: z
        .union([z.number().int(), z.string()])
        .optional()
        .describe("Entity ID or name (matches either subject or object)"),
      subject: z
        .union([z.number().int(), z.string()])
        .optional()
        .describe("Subject entity ID or name"),
      predicate: z.string().optional().describe("Predicate relation name"),
      object: z
        .union([z.number().int(), z.string()])
        .optional()
        .describe("Object entity ID or name"),
      context: z.string().optional().describe("Context scope filter"),
      statuses: z
        .array(ClaimStatusEnum)
        .optional()
        .describe("Allowed claim statuses (defaults to all)"),
      limit: z.number().int().min(1).max(500).default(50).describe("Maximum claims to return"),
      offset: z.number().int().min(0).default(0).describe("Pagination offset"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (args) => {
      try {
        const entityId = args.entityId ? resolveEntityId(sdk, args.entityId, "entity") : undefined;
        const subject = args.subject ? resolveEntityId(sdk, args.subject, "subject") : undefined;
        const object = args.object ? resolveEntityId(sdk, args.object, "object") : undefined;

        const claims = graph.claims.list({
          entityId,
          subject,
          predicate: args.predicate,
          object,
          context: args.context,
          statuses: args.statuses as ClaimStatus[] | undefined,
          limit: args.limit,
          offset: args.offset,
        });
        return formatToolResponse({ count: claims.length, claims });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  mcp.tool(
    "add_claim",
    "Adds an atomic, immutable factual claim or assertion to the knowledge graph.",
    claimInput.extend(auditContext("Add a factual claim via MCP")).shape,
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (args) => {
      try {
        return formatToolResponse(recordToolMutation(sdk, "add_claim", args, (args) => {
          const subjectId = resolveEntityId(sdk, args.subject, "subject");
          const objectId = args.object !== undefined ? resolveEntityId(sdk, args.object, "object") : undefined;

          const claim = graph.claims.add({ ...args, subject: subjectId, object: objectId });
          return claim;
        }));
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  mcp.tool(
    "batch_add_claims",
    "Adds multiple claims in a single atomic transaction.",
    { claims: z.array(claimInput).min(1).max(200), ...auditContext("Add a related batch of claims via MCP") },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (args) => {
      try {
        return formatToolResponse(recordToolMutation(sdk, "batch_add_claims", args, ({ claims }) => {
          const resolvedInputs = claims.map((c, i) => ({
            ...c,
            subject: resolveEntityId(sdk, c.subject, `claims[${i}].subject`),
            object: c.object !== undefined ? resolveEntityId(sdk, c.object, `claims[${i}].object`) : undefined,
        }));
        const results = sdk.database.transaction(() =>
          resolvedInputs.map((input) => graph.claims.add(input)),
        )();
        return ({ count: results.length, claims: results });
        }));
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  mcp.tool(
    "inspect_claim",
    "Returns complete audit trail for a claim: status history, review log, attached evidence citations, and claim links.",
    {
      id: z.string().describe("Claim UUID"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ id }) => {
      try {
        const inspection = graph.inspect(id);
        return formatToolResponse(inspection);
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  mcp.tool(
    "review_claim",
    "Updates a claim status (e.g. accept, dispute, reject) and logs the review audit record.",
    {
      claimId: z.string().describe("Claim UUID"),
      status: ClaimStatusEnum.describe("New claim status"),
      ...auditContext("Review a claim via MCP"),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async (args) => {
      try {
        return formatToolResponse(recordToolMutation(sdk, "review_claim", args, (args, context) => {
          const updated = graph.lifecycle.review(
            args.claimId,
            args.status,
            context.actor,
            context.reason,
          );
          return updated;
        }));
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  mcp.tool(
    "link_claims",
    "Establishes a semantic relationship between two claims (e.g. supports, contradicts, supersedes).",
    {
      from: z.string().describe("Source claim UUID"),
      to: z.string().describe("Target claim UUID"),
      relation: z
        .enum(["supports", "contradicts", "supersedes"])
        .describe("Link relation"),
      ...auditContext("Link related claims via MCP"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (args) => {
      try {
        return formatToolResponse(recordToolMutation(sdk, "link_claims", args, (args, context) => {
          graph.lifecycle.link(args.from, args.to, args.relation, context.actor, context.reason);
          return ({
            success: true,
            message: `Linked claim ${args.from} -> ${args.to} (${args.relation})`,
          });
        }));
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  mcp.tool(
    "find_conflicts",
    "Detects contradicting claims across overlapping validity intervals, opposite polarities, or conflicting single-target relations.",
    {
      entityId: z
        .union([z.number().int(), z.string()])
        .optional()
        .describe("Optional entity ID or name to scope conflict detection"),
      predicate: z.string().optional().describe("Optional predicate to filter"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (args) => {
      try {
        const entityId = args.entityId ? resolveEntityId(sdk, args.entityId, "entity") : undefined;
        const result = graph.conflicts.find({
          entityId,
          predicate: args.predicate,
        });
        return formatToolResponse({
          count: result.conflicts.length,
          conflicts: result.conflicts,
          truncated: result.truncated,
        });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );
}
