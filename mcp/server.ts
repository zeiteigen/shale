import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createExtensionSDK, type ShaleSDK } from "../sdk";
import { createScopedSDK, type ScopedSDK } from "../sdk/access";
import { registerKnowledgeGraphTools } from "./tools";
import { registerKnowledgeEditingTools } from "./edit-tools";
import { registerKnowledgeEditingPrompts } from "./edit-prompts";
import { registerKnowledgeGraphResources } from "./resources";
import { registerKnowledgeGraphPrompts } from "./prompts";
import { registerScoped } from "./access";

export interface KnowledgeGraphMcpServerOptions {
  name?: string;
  version?: string;
  sdk?: ShaleSDK;
  namespace?: string;
  /** Access profile (resources/access.json) whose permissions this server applies. Defaults to full access. */
  profile?: string;
  /** Pre-built scoped SDKs; takes precedence over `sdk` and `profile`. */
  access?: ScopedSDK;
}

/**
 * Creates and configures an MCP server instance for the Shale Knowledge Graph.
 * Registers tools, resources, and prompts against the profile's view of the graph.
 */
export function createKnowledgeGraphMcpServer(options: KnowledgeGraphMcpServerOptions = {}): McpServer {
  const sdk =
    options.sdk ??
    createExtensionSDK("mcp-server", {
      namespace: options.namespace ?? "knowledge",
    });
  const access = options.access ?? (options.profile ? createScopedSDK(options.profile, sdk) : undefined);
  const register = (module: (mcp: McpServer, sdk: ShaleSDK) => void) =>
    access ? registerScoped(mcp, access, module) : module(mcp, sdk);

  const mcp = new McpServer({
    name: options.name ?? "shale-knowledge-graph",
    version: options.version ?? "1.0.0",
  });

  register(registerKnowledgeGraphTools);
  register(registerKnowledgeEditingTools);
  registerKnowledgeGraphResources(mcp, access?.read ?? sdk);
  registerKnowledgeGraphPrompts(mcp);
  registerKnowledgeEditingPrompts(mcp);

  return mcp;
}
