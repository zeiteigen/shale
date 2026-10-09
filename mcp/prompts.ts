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
4. Summarize its identity, key relationships, and supporting facts.`,
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
3. Check for any contradicting claims or conflicts using find_conflicts.
4. Provide a recommendation on whether this claim should be accepted, disputed, or rejected.`,
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

1. Use search_graph with BM25 mode to locate relevant source chunks, passages, and graph neighborhoods.
2. Cross-reference the identified entities and claims with traverse_graph.
3. Check if there are existing accepted claims that support or contradict this statement.
4. Conclude whether the statement is supported, contradicted, or unknown based on the knowledge graph.`,
          },
        },
      ],
    }),
  );
}
