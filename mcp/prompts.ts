import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerKnowledgeGraphPrompts(mcp: McpServer) {
  mcp.prompt(
    "explore-entity",
    {
      entityName: z.string().describe("The name or label of the entity to explore"),
    },
    ({ entityName }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Please explore the entity "${entityName}" in the knowledge graph:
1. Use resolve_entities to find matching entities.
2. Use inspect_entity to examine its aliases, type, and recent claims.
3. Use traverse_graph to find connected entities up to depth 2.
4. Use search_graph to find relevant sources; it returns one retained-memory hit per source, and graph expansion must be requested explicitly.
5. Follow summaryVersionId or snippetVersionId with get_snippet when citing retained text. State when only a summary or excerpt is available; the original source may have been discarded.`,
          },
        },
      ],
    }),
  );

  mcp.prompt(
    "verify-claim",
    {
      claimId: z.string().describe("The ID of the claim to inspect and verify"),
    },
    ({ claimId }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Please verify claim "${claimId}" in the knowledge graph:
1. Inspect the claim details, validity interval, and confidence using inspect_claim.
2. Review the attached evidence citations using get_claim_evidence.
3. For cited sources, inspect retained memory with get_source_memory and retrieve a specific summary/snippet version with get_snippet.
4. Treat retained excerpts and derived summaries as partial evidence, not complete original content. If a current source read is needed, request refresh_source explicitly with actor and reason, and report unavailable responses plainly.
5. Check for contradicting claims or conflicts using find_conflicts, then recommend whether this claim should be accepted, disputed, or rejected.`,
          },
        },
      ],
    }),
  );

  mcp.prompt(
    "fact-check",
    {
      statement: z.string().describe("The statement or factual assertion to check against the knowledge base"),
    },
    ({ statement }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Please check the following statement against the knowledge graph:
"${statement}"

1. Use search_graph to find distinct sources. It returns retained summaries or snippet previews; graph expansion is off by default.
2. For a relevant hit, use get_source_memory to inspect its retained summary and active snippets. Follow summaryVersionId or snippetVersionId with get_snippet when you need the cited retained text.
3. If the retained memory is insufficient and a fresh read is appropriate, explicitly request refresh_source with an actor and reason (and a topic if useful). Treat an unavailable response as unavailable; do not infer that the original content can be recovered.
4. Cross-reference relevant entities and claims with traverse_graph, then check accepted claims that support or contradict this statement.
5. State whether the knowledge base supports, contradicts, or leaves the statement unknown. Distinguish retained excerpts from derived summaries and do not present either as complete original source content.`,
          },
        },
      ],
    }),
  );
}
