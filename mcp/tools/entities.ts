import { z } from "zod";
import { entityInput } from "../../sdk/knowledge/schemas";
import { auditContext, recordToolMutation } from "./audit";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShaleSDK } from "../../sdk";
import { resolveEntityId, formatToolResponse, formatToolError } from "../types";

export function registerEntitiesTools(mcp: McpServer, sdk: ShaleSDK) {
  const graph = sdk.graph;

  // ==========================================
  // 2. Entity Management Tools
  // ==========================================

  mcp.tool(
    "get_entity",
    "Retrieves an entity by its numeric ID, resolving to canonical identity if merged.",
    {
      id: z.number().int().describe("Numeric entity ID"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ id }) => {
      try {
        const entity = graph.entities.get(id);
        const canonical = graph.entities.canonical(id);
        return formatToolResponse({ ...entity, canonical });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  mcp.tool(
    "resolve_entities",
    "Resolves entities matching a name, alias, or external ID across namespaces and scopes.",
    {
      name: z.string().describe("Name, alias, or search term to match"),
      scope: z.string().optional().describe("Optional alias scope filter"),
      type: z.string().optional().describe("Optional entity type filter (e.g. Person, Organization)"),
      namespace: z.string().optional().describe("Optional graph namespace"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (args) => {
      try {
        const entities = graph.entities.resolve(args.name, args.scope ?? "", args.namespace);
        const filtered = args.type ? entities.filter((e) => e.type === args.type) : entities;
        return formatToolResponse({ count: filtered.length, entities: filtered });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  mcp.tool(
    "create_entity",
    "Creates a new entity in the knowledge graph with optional aliases and external IDs.",
    entityInput.extend(auditContext("Create an entity via MCP")).shape,
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (args) => {
      try {
        return formatToolResponse(recordToolMutation(sdk, "create_entity", args, (args) => {
          const entity = graph.entities.create(args);
          return entity;
        }));
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  mcp.tool(
    "rename_entity",
    "Renames an entity's primary name and records the old name as an alias.",
    {
      id: z.number().int().describe("Numeric entity ID"),
      name: z.string().describe("New primary name"),
      ...auditContext("Correct an entity name via MCP"),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async (args) => {
      try {
        return formatToolResponse(recordToolMutation(sdk, "rename_entity", args, ({ id, name }) => {
          const entity = graph.entities.rename(id, name);
          return entity;
        }));
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  mcp.tool(
    "merge_entities",
    "Reversibly merges one entity into another canonical entity, preserving all past aliases and history.",
    {
      from: z.union([z.number().int(), z.string()]).describe("Source entity ID or name to be merged"),
      into: z.union([z.number().int(), z.string()]).describe("Target canonical entity ID or name"),
      ...auditContext("Merge duplicate entities via MCP"),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async (args) => {
      try {
        return formatToolResponse(recordToolMutation(sdk, "merge_entities", args, (args, context) => {
          const fromId = resolveEntityId(sdk, args.from, "from entity");
          const intoId = resolveEntityId(sdk, args.into, "into entity");
          const changeId = graph.entities.merge(
            fromId,
            intoId,
            context.reason,
          );
          return ({
            success: true,
            changeId,
            message: `Merged entity #${fromId} into #${intoId}. Can be reverted using unmerge_entities with changeId: ${changeId}`,
          });
        }));
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  mcp.tool(
    "unmerge_entities",
    "Reverses a previous identity merge using its audit change ID.",
    {
      changeId: z.string().describe("Audit change ID returned when the merge was performed"),
      ...auditContext("Reverse an identity merge via MCP"),
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async (args) => {
      try {
        return formatToolResponse(recordToolMutation(sdk, "unmerge_entities", args, ({ changeId }) => {
          graph.entities.unmerge(changeId);
          return ({ success: true, message: `Reverted merge change #${changeId}` });
        }));
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  mcp.tool(
    "inspect_entity",
    "Returns complete audit record of an entity: names, aliases, merges, external IDs, and canonical identity.",
    {
      id: z.union([z.number().int(), z.string()]).describe("Entity ID or name to inspect"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ id }) => {
      try {
        const entityId = resolveEntityId(sdk, id, "entity to inspect");
        const inspection = graph.entities.inspect(entityId);
        return formatToolResponse(inspection);
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  mcp.tool(
    "add_entity_alias",
    "Adds an alias or alternate name to an existing entity.",
    {
      id: z.union([z.number().int(), z.string()]).describe("Entity ID or name"),
      alias: z.string().describe("Alias string to attach"),
      scope: z.string().optional().describe("Optional scope (e.g. project, domain, or language)"),
      ...auditContext("Add an entity alias via MCP"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (args) => {
      try {
        return formatToolResponse(recordToolMutation(sdk, "add_entity_alias", args, ({ id, alias, scope }) => {
          const entityId = resolveEntityId(sdk, id, "entity");
          graph.entities.addAlias(entityId, alias, scope);
          return ({
            success: true,
            message: `Added alias "${alias}" to entity #${entityId}`,
          });
        }));
      } catch (err) {
        return formatToolError(err);
      }
    },
  );
}
