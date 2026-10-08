import { z } from "zod";
import { evidenceInput } from "../../sdk/knowledge/schemas";
import { auditContext, recordToolMutation } from "./audit";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShaleSDK } from "../../sdk";
import { formatToolResponse, formatToolError } from "../types";

export function registerEvidenceTools(mcp: McpServer, sdk: ShaleSDK) {
  const graph = sdk.graph;

  // ==========================================
  // 6. Evidence & Grounding Tools
  // ==========================================

  mcp.tool(
    "add_evidence",
    "Attaches textual grounding evidence from an ingested source revision and chunk to a claim.",
    evidenceInput.extend({
      claimId: z.string().min(1).describe("Claim UUID"),
      stance: z.enum(["supports", "contradicts", "mentions", "refutes", "neutral"]).default("supports"),
      method: z.string().default("manual"),
      ...auditContext("Attach claim evidence via MCP"),
    }).shape,
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (args) => {
      try {
        return formatToolResponse(recordToolMutation(sdk, "add_evidence", args, (args) => {
          const { claimId, stance, ...evidence } = args;
          const id = graph.evidence.add(claimId, {
            ...evidence,
            stance: stance === "refutes" ? "contradicts" : stance === "neutral" ? "mentions" : stance,
          });
          return ({ success: true, evidenceId: id, message: `Evidence attached to claim ${claimId}` });
        }));
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  mcp.tool(
    "get_claim_evidence",
    "Lists all evidence citations and source citations attached to a claim.",
    {
      claimId: z.string().describe("Claim UUID"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ claimId }) => {
      try {
        const evidence = graph.evidence.list(claimId);
        return formatToolResponse({ count: evidence.length, evidence });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );
}
