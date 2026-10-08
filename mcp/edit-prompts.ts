import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

function message(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

export function registerKnowledgeEditingPrompts(mcp: McpServer) {
  mcp.prompt("discover-evidence-connect", {
    entity: z.string().describe("Entity name or numeric ID to investigate"),
    goal: z.string().describe("Relationship or question to investigate"),
  }, ({ entity, goal }) => message(`Investigate connections for entity ${entity}: ${goal}.
Resolve the exact entity ID and inspect existing claims and connections. Use find_connection_candidates and search_graph to discover leads. Inspect the source chunks and historical revisions before quoting them. Distinguish source-supported relationships from similarity suggestions. Present candidate connections and their evidence for review; never create claims merely because a candidate tool suggested them. When an edit is authorized, use connect_entities with exact IDs, explicit evidence, actor, reason, and the observed expected versions where supported.`));

  mcp.prompt("refine-graph", {
    entity: z.string().describe("Entity name or numeric ID whose graph needs refinement"),
    goal: z.string().describe("Desired correction or refinement"),
  }, ({ entity, goal }) => message(`Refine the graph around ${entity}: ${goal}.
Resolve and inspect the entity, connections, evidence, and conflicts. Use find_duplicate_entities only to identify leads; inspect identities before choosing a merge or split. Prefer revising claims and explicit lifecycle changes that retain provenance. Form a bounded batch of {type,args} operations with actor, reason, and expectedVersion values from current records. Preview the proposed edits and explain their effects. Apply only edits within the user's authorized scope, then inspect the affected records.`));

  mcp.prompt("remove-spam-edit-chunks", {
    sourceId: z.string().describe("Exact source ID to inspect"),
    goal: z.string().describe("Spam removal or chunk correction requested"),
  }, ({ sourceId, goal }) => message(`Inspect source ${sourceId} and perform the requested cleanup: ${goal}.
Use inspect_source and list_chunks to obtain current IDs, versions, and content. Inspect affected evidence and historical revisions before choosing edits. For isolated text errors use revise_chunk; for an unwanted chunk use remove_chunk; for an unwanted source use remove_source. Source removal archives its content, preserving historical evidence. Set blockReingestion only when ongoing automatic ingestion should be blocked. Preview the exact operations with concurrency versions, actor, and reason. Apply the authorized changes and inspect the resulting source. Explain how restore_source can restore archived content and optionally unblock reingestion.`));

  mcp.prompt("preview-apply-graph-changes", {
    changes: z.string().describe("Requested graph edits or JSON batch to inspect"),
  }, ({ changes }) => message(`Prepare and review these graph changes: ${changes}.
Inspect referenced entities, claims, sources, and chunks to resolve exact IDs and current versions. Build an ordered batch with actor, reason, optional requestId, and operations in {type,args} format. New entity ref values can be referenced as @ref within supported batch operations. Run preview_graph_changes and explain the proposed effects or validation errors. Preview does not reserve IDs or versions. Apply the same authorized operations through apply_graph_changes after resolving errors; re-read stale records before revising a conflicted batch. Reuse a requestId only for an exact retry of the same payload. Inspect the changed records and report the resulting change ID.`));
}
