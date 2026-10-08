import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShaleSDK } from "../../sdk";
import { formatToolResponse, formatToolError } from "../types";

export function registerStatsTools(mcp: McpServer, sdk: ShaleSDK) {
  const graph = sdk.graph;

  // ==========================================
  // 7. Graph Overview & Statistics
  // ==========================================

  mcp.tool(
    "get_graph_stats",
    "Retrieves overall statistics of the knowledge graph: entity counts, claim counts, and breakdown by status.",
    {},
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async () => {
      try {
        const entitiesCount =
          sdk.database
            .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM entities")
            .get()?.count ?? 0;
        const claimsCount =
          sdk.database
            .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM graph_claims")
            .get()?.count ?? 0;
        const edgesCount =
          sdk.database
            .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM edges")
            .get()?.count ?? 0;
        const claimsByStatus = sdk.database
          .query<{ status: string; count: number }, []>(
            "SELECT status, COUNT(*) AS count FROM graph_claims GROUP BY status",
          )
          .all();
        const topEntityTypes = sdk.database
          .query<{ type: string; count: number }, []>(
            "SELECT type, COUNT(*) AS count FROM entities GROUP BY type ORDER BY count DESC LIMIT 10",
          )
          .all();

        return formatToolResponse({
          entitiesCount,
          claimsCount,
          edgesCount,
          claimsByStatus: Object.fromEntries(
            claimsByStatus.map((r) => [r.status, r.count]),
          ),
          topEntityTypes,
        });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );
}
