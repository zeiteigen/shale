import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShaleSDK } from "../sdk";

export function registerKnowledgeGraphResources(mcp: McpServer, sdk: ShaleSDK) {
  const graph = sdk.graph;
  mcp.resource('graph-changes','graph://changes',async uri=>({contents:[{uri:uri.href,mimeType:'application/json',text:JSON.stringify(sdk.knowledge.history())}]}));
  mcp.resource('graph-change',new ResourceTemplate('graph://changes/{id}',{list:undefined}),async(uri,{id})=>{
    const change=sdk.knowledge.history(String(id));
    if(!change) throw new Error(`Unknown graph change ${id}`);
    return {contents:[{uri:uri.href,mimeType:'application/json',text:JSON.stringify(change)}]};
  });

  // Static resource: graph stats
  mcp.resource("graph-stats", "graph://stats", async (uri) => {
    const entitiesCount =
      sdk.database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM entities")
        .get()?.count ?? 0;
    const claimsCount =
      sdk.database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM graph_claims")
        .get()?.count ?? 0;
    const claimsByStatus = sdk.database
      .query<{ status: string; count: number }, []>(
        "SELECT status, COUNT(*) AS count FROM graph_claims GROUP BY status",
      )
      .all();
    const stats = {
      entitiesCount,
      claimsCount,
      claimsByStatus: Object.fromEntries(
        claimsByStatus.map((r) => [r.status, r.count]),
      ),
    };

    return {
      contents: [
        {
          uri: uri.href,
          text: JSON.stringify(stats, null, 2),
          mimeType: "application/json",
        },
      ],
    };
  });

  // Static resource: relations
  mcp.resource("graph-relations", "graph://relations", async (uri) => {
    const rows = sdk.database
      .query<{ name: string; definition: string }, []>(
        "SELECT name, definition FROM graph_relations ORDER BY name",
      )
      .all();
    const relations = rows.map((r) => JSON.parse(r.definition));

    return {
      contents: [
        {
          uri: uri.href,
          text: JSON.stringify({ relations }, null, 2),
          mimeType: "application/json",
        },
      ],
    };
  });

  // Dynamic resource: entity by ID
  mcp.resource(
    "graph-entity",
    new ResourceTemplate("graph://entities/{id}", { list: undefined }),
    async (uri, { id }) => {
      const numId = Number(id);
      if (!Number.isInteger(numId)) {
        throw new Error(`Invalid entity ID in URI: ${id}`);
      }
      const entity = graph.entities.inspect(numId);
      const claims = graph.claims.list({ entityId: numId, limit: 100 });

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify({ ...entity, claims }, null, 2),
            mimeType: "application/json",
          },
        ],
      };
    },
  );

  // Dynamic resource: claim by ID
  mcp.resource(
    "graph-claim",
    new ResourceTemplate("graph://claims/{id}", { list: undefined }),
    async (uri, { id }) => {
      const claimId = String(id);
      const inspection = graph.inspect(claimId);

      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(inspection, null, 2),
            mimeType: "application/json",
          },
        ],
      };
    },
  );
}
