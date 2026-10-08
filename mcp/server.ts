import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createExtensionSDK, type ShaleSDK } from "../sdk";
import { registerKnowledgeGraphTools } from "./tools";
import { registerKnowledgeEditingTools } from "./edit-tools";
import { registerKnowledgeEditingPrompts } from "./edit-prompts";
import { registerKnowledgeGraphResources } from "./resources";
import { registerKnowledgeGraphPrompts } from "./prompts";

export interface KnowledgeGraphMcpServerOptions {
  name?: string;
  version?: string;
  sdk?: ShaleSDK;
  namespace?: string;
}

/**
 * Creates and configures an MCP server instance for the Shale Knowledge Graph.
 * Registers tools, resources, and prompts.
 */
export function createKnowledgeGraphMcpServer(options: KnowledgeGraphMcpServerOptions = {}): McpServer {
  const sdk =
    options.sdk ??
    createExtensionSDK("mcp-server", {
      namespace: options.namespace ?? "knowledge",
    });

  const mcp = new McpServer({
    name: options.name ?? "shale-knowledge-graph",
    version: options.version ?? "1.0.0",
  });

  registerKnowledgeGraphTools(mcp, sdk);
  registerKnowledgeEditingTools(mcp, sdk);
  registerKnowledgeGraphResources(mcp, sdk);
  registerKnowledgeGraphPrompts(mcp);
  registerKnowledgeEditingPrompts(mcp);

  return mcp;
}
