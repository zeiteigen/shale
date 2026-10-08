import type { ShaleSDK } from "../sdk";
import { toolErrorDetails } from "./errors";

/**
 * Resolves an entity ID from either a numeric ID or a name string.
 * If a name is passed, queries `graph.entities.resolve(name)`.
 * Throws a clear error if no matching entity or multiple matching entities exist.
 */
export function resolveEntityId(
  sdk: ShaleSDK,
  identifier: number | string,
  fieldLabel = "entity",
): number {
  if (typeof identifier === "number") {
    return identifier;
  }

  const numeric = Number(identifier);
  if (Number.isInteger(numeric) && String(numeric) === identifier.trim()) {
    return numeric;
  }

  const trimmed = identifier.trim();
  const resolved = sdk.graph.entities.resolve(trimmed);
  if (resolved.length === 0) {
    throw new Error(
      `Could not resolve ${fieldLabel} "${identifier}". No matching entity found in graph.`,
    );
  }
  if (resolved.length > 1) {
    const candidates = resolved.map((e) => `#${e.id} "${e.name}" (${e.type})`).join(", ");
    throw new Error(
      `Ambiguous ${fieldLabel} "${identifier}". Multiple matches found: ${candidates}. Please specify the numeric entity ID.`,
    );
  }

  return resolved[0].id;
}

export function formatToolResponse(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

export function formatToolError(error: unknown) {
  const details = toolErrorDetails(error);
  return {
    isError: true,
    structuredContent: { error: details },
    content: [
      {
        type: "text" as const,
        text: `Error: ${details.message}`,
      },
    ],
  };
}
