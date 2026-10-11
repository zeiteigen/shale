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
Resolve the exact entity ID and inspect existing claims and connections. Use find_connection_candidates and search_graph to discover leads. Search results represent retained summaries or excerpts, not complete source bodies. Use get_source_memory and cite summaryVersionId/snippetVersionId with get_snippet before quoting retained text. If a fresh read is needed, request refresh_source explicitly with actor and reason; report unavailable responses without implying the discarded original can be recovered. Distinguish source-supported relationships from similarity suggestions. Present candidates and evidence for review; never create claims merely because a candidate tool suggested them. When an edit is authorized, use connect_entities with exact IDs, explicit evidence, actor, reason, and observed expected versions where supported.`));

  mcp.prompt("refine-graph", {
    entity: z.string().describe("Entity name or numeric ID whose graph needs refinement"),
    goal: z.string().describe("Desired correction or refinement"),
  }, ({ entity, goal }) => message(`Refine the graph around ${entity}: ${goal}.
Resolve and inspect the entity, connections, evidence, and conflicts. Use find_duplicate_entities only to identify leads; inspect identities before choosing a merge or split. Prefer revising claims and explicit lifecycle changes that retain provenance. Form a bounded batch of {type,args} operations with actor, reason, and expectedVersion values from current records. Preview the proposed edits and explain their effects. Apply only edits within the user's authorized scope, then inspect the affected records.`));

  mcp.prompt("remove-spam-edit-chunks", {
    sourceId: z.string().describe("Exact source ID to inspect"),
    goal: z.string().describe("Spam removal or chunk correction requested"),
  }, ({ sourceId, goal }) => message(`Inspect source ${sourceId} and perform the requested cleanup: ${goal}.
Use inspect_source and list_chunks to obtain current IDs, versions, and retained content. Retained source memory may contain only a summary and selected snippets; do not describe it as a complete original body. Use get_source_memory and get_snippet for retained-memory citations. For an authorized memory curation, use edit_source_memory with expectedVersion, actor, and reason: excerpts must match observed text, while new interpretation must be marked derived. For a source chunk correction use revise_chunk; for an unwanted chunk use remove_chunk; for an unwanted source use remove_source. Source removal archives retained content and evidence history. Request refresh_source explicitly if a fresh owner read is needed; it may be unavailable. Preview source edits with current concurrency versions, then inspect the result.`));

  mcp.prompt("preview-apply-graph-changes", {
    changes: z.string().describe("Requested graph edits or JSON batch to inspect"),
  }, ({ changes }) => message(`Prepare and review these graph changes: ${changes}.
Inspect referenced entities, claims, sources, and retained chunks to resolve exact IDs and current versions. Source summaries and snippets are not complete original bodies; retrieve retained citations with get_source_memory/get_snippet, and request refresh_source explicitly if the source owner should try a fresh read. For memory edits, excerpts must match observed text and new interpretation must be marked derived. Build an ordered batch with actor, reason, optional requestId, and operations in {type,args} format. New entity ref values can be referenced as @ref within supported batch operations. Run preview_graph_changes and explain the proposed effects or validation errors. Preview does not reserve IDs or versions. Apply authorized operations through apply_graph_changes after resolving errors; re-read stale records before revising a conflicted batch. Reuse a requestId only for an exact retry of the same payload. Inspect changed records and report the resulting change ID.`));
}
