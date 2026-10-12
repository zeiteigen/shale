import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ScopedSDK } from "../sdk/access";
import { formatToolError } from "./types";

type ToolCallback = (args: Record<string, unknown>, extra: unknown) => unknown;

/** Previews simulate writes, so they run on the write connection like other edits. */
const WRITE_SIDE_READ_ONLY_TOOLS = new Set(["preview_graph_changes"]);

function isReadOnly(name: string, annotations: { readOnlyHint?: boolean } | undefined) {
  return annotations?.readOnlyHint === true && !WRITE_SIDE_READ_ONLY_TOOLS.has(name);
}

/**
 * A view of `mcp` that registers only one side's tools. Tool modules register everything against
 * one SDK, so each module runs twice: once with the scoped reader (read tools kept) and once with
 * the guarded writer (write tools kept, wrapped).
 */
function toolSubset(mcp: McpServer, keep: (name: string, readOnly: boolean) => boolean,
  wrap: (name: string, callback: ToolCallback) => ToolCallback = (_, callback) => callback): McpServer {
  return new Proxy(mcp, {
    get(target, property) {
      if (property === "tool") return (...args: unknown[]) => {
        const name = args[0] as string;
        const annotations = args.slice(1, -1).find(arg => arg !== null && typeof arg === "object" && "readOnlyHint" in arg) as
          { readOnlyHint?: boolean } | undefined;
        if (!keep(name, isReadOnly(name, annotations))) return undefined;
        args[args.length - 1] = wrap(name, args[args.length - 1] as ToolCallback);
        return (target.tool as (...a: unknown[]) => unknown)(...args);
      };
      if (property === "registerTool") return (name: string, config: { annotations?: { readOnlyHint?: boolean } }, callback: ToolCallback) => {
        if (!keep(name, isReadOnly(name, config.annotations))) return undefined;
        return (target.registerTool as (...a: unknown[]) => unknown)(name, config, wrap(name, callback));
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Register a tool module for an access profile. Read tools see only the profile's records;
 * write tools are omitted for read-only profiles and otherwise check every referenced record,
 * resolve entity names among visible entities, and attribute the change to the profile.
 */
export function registerScoped(mcp: McpServer, access: ScopedSDK, register: (mcp: McpServer, sdk: ScopedSDK["read"]) => void) {
  if (access.profile.unrestricted) return register(mcp, access.read);
  register(toolSubset(mcp, (_, readOnly) => readOnly), access.read);
  if (access.profile.write === false || !access.guard) return;
  const guard = access.guard;
  register(toolSubset(mcp, (_, readOnly) => !readOnly, (name, callback) => async (args, extra) => {
    try {
      const prepared = guard.prepare(name, args ?? {});
      if (typeof prepared.actor === "string" && !prepared.actor.startsWith("profile:"))
        prepared.actor = `profile:${guard.profileName}/${prepared.actor}`;
      return await callback(prepared, extra);
    } catch (error) {
      return formatToolError(error);
    }
  }), access.write);
}
