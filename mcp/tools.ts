import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShaleSDK } from "../sdk";
import { registerSearchTools } from "./tools/search";
import { registerEntitiesTools } from "./tools/entities";
import { registerClaimsTools } from "./tools/claims";
import { registerRelationsTools } from "./tools/relations";
import { registerEventsTools } from "./tools/events";
import { registerEvidenceTools } from "./tools/evidence";
import { registerStatsTools } from "./tools/stats";

export function registerKnowledgeGraphTools(mcp: McpServer, sdk: ShaleSDK) {
  registerSearchTools(mcp, sdk);
  registerEntitiesTools(mcp, sdk);
  registerClaimsTools(mcp, sdk);
  registerRelationsTools(mcp, sdk);
  registerEventsTools(mcp, sdk);
  registerEvidenceTools(mcp, sdk);
  registerStatsTools(mcp, sdk);
}
