import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShaleSDK } from "../../sdk";
import { EpisodeStore } from "../../sdk/graph/episodes";
import { auditContext, recordToolMutation } from "./audit";
import { formatToolError, formatToolResponse, resolveEntityId } from "../types";

const day = (ms: number | null) => ms === null ? null : new Date(ms).toISOString().slice(0, 10);

/** Episodes: the user's pursuits across sources, with their timelines. */
export function registerEpisodeTools(mcp: McpServer, sdk: ShaleSDK) {
  const store = () => new EpisodeStore(sdk.database, sdk.graph);

  mcp.tool(
    "list_episodes",
    "List the user's episodes: ongoing pursuits that span sources over time (applying to a club, a project, a job search), most recently active first. Filter by text, status, or an involved entity.",
    {
      query: z.string().max(500).optional().describe("Words to match against episode titles, summaries, and aliases"),
      status: z.enum(["active", "dormant", "closed"]).optional(),
      entity: z.union([z.number().int(), z.string()]).optional().describe("Only episodes involving this entity (ID or name)"),
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (args) => {
      try {
        const entityId = args.entity === undefined ? undefined : resolveEntityId(sdk, args.entity);
        const episodes = store().list({ query: args.query, status: args.status, entityId, limit: args.limit, offset: args.offset });
        return formatToolResponse({ count: episodes.length, episodes: episodes.map(episode => ({ ...episode,
          startedAt: day(episode.startedAt), lastActivityAt: day(episode.lastActivityAt) })) });
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  mcp.tool(
    "get_episode",
    "Read one episode: its summary, the people, organizations, and artifacts it involves, and a dated timeline of member sources with each step, role, and source summary.",
    { id: z.number().int().describe("Episode entity ID"), maxChars: z.number().int().min(1000).max(64000).default(16000) },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ id, maxChars }) => {
      try {
        const episode = store().get(id);
        if (!episode) throw new Error(`Episode ${id} not found`);
        return formatToolResponse({ ...episode, startedAt: day(episode.startedAt), lastActivityAt: day(episode.lastActivityAt),
          members: episode.members.map(member => ({ ...member, at: day(member.at) })) }, maxChars);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  mcp.tool(
    "entity_timeline",
    "Everything known about an entity in time order: the sources that mention it (with digest summaries) and the episodes it is part of.",
    {
      entity: z.union([z.number().int(), z.string()]).describe("Entity ID or name"),
      limit: z.number().int().min(1).max(200).default(50),
      maxChars: z.number().int().min(1000).max(64000).default(16000),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (args) => {
      try {
        const id = sdk.graph.entities.canonical(resolveEntityId(sdk, args.entity)).id;
        const sources = sdk.database.query<{ id: string; title: string; origin: string; at: number; summary: string | null }, [number, number]>(`
          SELECT s.id,s.title,s.origin,s.created_at AS at,d.summary FROM source_entities se JOIN sources s ON s.id=se.source_id
          LEFT JOIN graph_source_digests d ON d.source_id=s.id
          WHERE se.entity_id IN (WITH RECURSIVE m(id) AS (SELECT ?1 UNION SELECT e.id FROM entities e JOIN m ON e.canonical_id=m.id) SELECT id FROM m)
          GROUP BY s.id ORDER BY s.created_at LIMIT ?`).all(id, args.limit);
        return formatToolResponse({ entity: sdk.graph.entities.get(id),
          sources: sources.map(source => ({ ...source, at: day(source.at) })),
          episodes: store().list({ entityId: id, limit: 20 }) }, args.maxChars);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  mcp.tool(
    "merge_episodes",
    "Fold one episode into another when they are the same pursuit split in two. unmerge_entities with the returned change ID separates their identities and memberships; generated narratives are refreshed by consolidation.",
    { from: z.number().int(), into: z.number().int(), ...auditContext("Merge episodes via MCP") },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (args) => {
      try {
        return formatToolResponse(recordToolMutation(sdk, "merge_episodes", args, (input, context) =>
          ({ changeId: store().merge(input.from, input.into, `${context.actor}: ${context.reason}`) })));
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  mcp.tool(
    "detach_from_episode",
    "Remove a source from an episode it does not belong to. The membership claim is retracted, not deleted, and the source is not reassigned automatically.",
    { episode: z.number().int(), sourceId: z.string().min(1), ...auditContext("Detach a source from an episode via MCP") },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async (args) => {
      try {
        return formatToolResponse(recordToolMutation(sdk, "detach_from_episode", args, (input, context) => {
          store().detach(input.episode, input.sourceId, context.actor, context.reason);
          return { success: true };
        }));
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  mcp.tool(
    "split_episode",
    "Move some of an episode's sources into a new episode with its own title, when one episode wrongly combines two pursuits.",
    { episode: z.number().int(), sourceIds: z.array(z.string().min(1)).min(1).max(200), title: z.string().trim().min(1).max(120),
      ...auditContext("Split an episode via MCP") },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    async (args) => {
      try {
        return formatToolResponse(recordToolMutation(sdk, "split_episode", args, (input, context) => {
          const episodes = store();
          const original = episodes.get(input.episode);
          if (!original) throw new Error(`Episode ${input.episode} not found`);
          const moving = original.members.filter(member => input.sourceIds.includes(member.sourceId));
          if (moving.length !== new Set(input.sourceIds).size) throw new Error("Every source must be a member of the episode");
          const created = episodes.create({ title: input.title, kind: original.kind, at: moving[0]!.at });
          for (const member of moving) {
            episodes.detach(original.id, member.sourceId, context.actor, context.reason);
            episodes.attach(created, member.sourceId, { role: member.role, step: member.step, at: member.at, confidence: 1,
              status: "accepted", basis: `split by ${context.actor}`, method: "manual" });
          }
          sdk.database.query("UPDATE graph_source_digests SET episode_state='assigned' WHERE source_id IN (SELECT value FROM json_each(?))")
            .run(JSON.stringify(input.sourceIds));
          return { episodeId: created, moved: moving.length };
        }));
      } catch (error) {
        return formatToolError(error);
      }
    },
  );
}
