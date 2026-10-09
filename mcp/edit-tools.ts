import type { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShaleSDK } from "../sdk";
import { changeInput, mutationContext, mutationSchemas, readSchemas, type MutationName, type MutationArgs } from "../sdk/knowledge/schemas";
import { formatToolError, formatToolResponse } from "./types";

const descriptions: Record<string, string> = {
  update_entity: "Update an entity's name or type using its numeric ID and optional expected version; records the actor and reason in the change history.",
  remove_entity_alias: "Remove one scoped alias from an entity without removing the entity or its other aliases.",
  split_entity: "Separate an incorrectly combined identity into new entities, explicitly assigning aliases, claims, and chunk links to each destination.",
  connect_entities: "Create an entity-to-entity connection with optional source evidence, validity dates, qualifiers, and claim dependencies.",
  revise_connection: "Replace a connection with a revised immutable claim, retaining the original claim and its history.",
  retract_connection: "Retract a connection while retaining its claim, evidence, and audit history for inspection.",
  revise_claim: "Revise an immutable claim by creating its replacement and preserving the prior claim and provenance.",
  unlink_claims: "Remove a supports, contradicts, or supersedes link between two claims while preserving the claims themselves.",
  add_claim_dependency: "Record that a claim depends on another claim so dependency lifecycle rules can be enforced.",
  remove_claim_dependency: "Remove one dependency between claims while retaining both claims and their other dependencies.",
  batch_review_claims: "Set review statuses for several claims atomically, with an optional expected version for each claim.",
  revise_evidence: "Revise an evidence citation's source locator, quote, stance, or extraction metadata while retaining its audit history.",
  retract_evidence: "Retract a citation from active evidence while retaining historical evidence and source revision references.",
  revise_event: "Revise event details and optionally replace its participant list, retaining the event's change history.",
  append_graph: "Append entities and claims together atomically; use entity ref names and @ref references to connect newly created entities.",
  add_source: "Create a text source and its initial chunked revision, ready for local retrieval and evidence citations.",
  update_source: "Update source title, URI, or metadata with optional optimistic concurrency protection.",
  remove_source: "Archive a source and its active chunks; optionally block automatic reingestion while retaining historical evidence.",
  restore_source: "Restore an archived source and its chunks; optionally lift its reingestion block.",
  add_chunk: "Append a verbatim or synthetic chunk to a live source revision, optionally linking it to entities and claims.",
  revise_chunk: "Revise a source chunk's text, type, or graph links while preserving older source revisions for evidence.",
  remove_chunk: "Remove a chunk from a live source revision while retaining historical revision content and evidence.",
  list_entities: "Find entities by name, type, or namespace with bounded pagination; returns numeric IDs for precise edits.",
  list_connections: "List connections around an entity, filtered by direction, predicate, context, or claim status.",
  get_source_revision: "Read an immutable historical source revision and its chunks, including archived content cited by evidence.",
  find_connection_candidates: "Suggest possible connections for review from shared evidence and full-text matches; does not create claims.",
  find_duplicate_entities: "Suggest potentially duplicate entities for inspection and review; does not merge or alter identities.",
  list_sources: "Find live or archived sources by title, URI, origin, type, or namespace with bounded pagination.",
  inspect_source: "Inspect source metadata, lifecycle state, revision references, and reingestion block before editing.",
  list_chunks: "List current or archived source chunks with IDs and versions for inspection and precise edits.",
};

/** Register the audited editing surface using the SDK's shared validation schemas. */
export function registerKnowledgeEditingTools(mcp: McpServer, sdk: ShaleSDK) {
  for (const [name, schema] of Object.entries(mutationSchemas)) {
    mcp.registerTool(name, {
      description: descriptions[name],
      inputSchema: schema.extend(mutationContext),
      annotations: {
        readOnlyHint: false,
        destructiveHint: /^(remove|retract|split|unlink|revise|update)_/.test(name),
        idempotentHint: false,
        openWorldHint: false,
      },
    }, async (input: MutationArgs<MutationName> & { actor: string; reason: string; requestId?: string }) => {
      try {
        const { actor, reason, requestId, ...args } = input;
        return formatToolResponse(await sdk.knowledge.mutate(name as MutationName, args as MutationArgs<MutationName>, { actor, reason, requestId }));
      } catch (error) {
        return formatToolError(error);
      }
    });
  }

  for (const [name, schema] of Object.entries(readSchemas)) {
    mcp.registerTool(name, {
      description: descriptions[name],
      inputSchema: schema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (args: z.infer<(typeof readSchemas)[keyof typeof readSchemas]>) => {
      try {
        return formatToolResponse(await sdk.knowledge.read(name as keyof typeof readSchemas, args));
      } catch (error) {
        return formatToolError(error);
      }
    });
  }

  mcp.registerTool("apply_graph_changes", {
    description: "Apply a bounded ordered batch of graph and source operations atomically, recording actor, reason, and an optional retry request ID.",
    inputSchema: changeInput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, async (args) => {
    try {
      return formatToolResponse(await sdk.knowledge.apply(args));
    } catch (error) {
      return formatToolError(error);
    }
  });

  mcp.registerTool("preview_graph_changes", {
    description: "Validate and simulate an ordered editing batch, returning its proposed effects without committing changes; preview does not reserve IDs or versions.",
    inputSchema: changeInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args) => {
    try {
      return formatToolResponse(await sdk.knowledge.preview(args));
    } catch (error) {
      return formatToolError(error);
    }
  });
}
