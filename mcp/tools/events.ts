import { z } from "zod";
import { auditContext, recordToolMutation } from "./audit";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShaleSDK } from "../../sdk";
import { resolveEntityId, formatToolResponse, formatToolError } from "../types";

const ClaimStatusEnum = z.enum([
  "proposed",
  "accepted",
  "rejected",
  "disputed",
  "stale",
  "retracted",
  "superseded",
]);

export function registerEventsTools(mcp: McpServer, sdk: ShaleSDK) {
  const graph = sdk.graph;

  // ==========================================
  // 5. Events & Timeline Tools
  // ==========================================

  mcp.tool(
    "create_event",
    "Creates a structured historical or planned event with temporal bounds and participant roles.",
    {
      name: z.string().describe("Event title or label"),
      kind: z.string().describe("Kind of event (e.g. Meeting, Acquisition, Release, Incident)"),
      occurredFrom: z.number().int().optional().describe("Start timestamp in ms"),
      occurredTo: z.number().int().optional().describe("End timestamp in ms"),
      context: z.string().optional().describe("Context scope"),
      participants: z
        .array(
          z.object({
            entity: z.union([z.number().int(), z.string()]).describe("Participant entity ID or name"),
            role: z.string().describe("Role name (e.g. host, attendee, buyer, target)"),
            position: z.number().int().optional(),
          }),
        )
        .default([])
        .describe("Participants in the event"),
      status: ClaimStatusEnum.default("proposed"),
      ...auditContext("Create an event via MCP"),
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async (args) => {
      try {
        return formatToolResponse(recordToolMutation(sdk, "create_event", args, (args) => {
          const resolvedParticipants = args.participants.map((p, i) => ({
            ...p,
            entity: resolveEntityId(sdk, p.entity, `participants[${i}].entity`),
        }));
        const record = graph.events.create({
          name: args.name,
          kind: args.kind,
          occurredFrom: args.occurredFrom,
          occurredTo: args.occurredTo,
          context: args.context,
          participants: resolvedParticipants,
          status: args.status,
        });
        return (record);
        }));
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  mcp.tool(
    "get_event",
    "Retrieves an event and its participants by entity ID.",
    {
      id: z.number().int().describe("Numeric event entity ID"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async ({ id }) => {
      try {
        const event = graph.events.get(id);
        return formatToolResponse(event);
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  mcp.tool(
    "list_events",
    "Queries events by kind, context, or time range.",
    {
      kind: z.string().optional().describe("Filter by event kind"),
      context: z.string().optional().describe("Filter by context"),
      from: z.number().int().optional().describe("Minimum timestamp"),
      to: z.number().int().optional().describe("Maximum timestamp"),
      limit: z.number().int().min(1).max(200).default(50),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (args) => {
      try {
        const events = graph.events.list({
          kind: args.kind,
          context: args.context,
          from: args.from,
          to: args.to,
          limit: args.limit,
        });
        return formatToolResponse({ count: events.length, events });
      } catch (err) {
        return formatToolError(err);
      }
    },
  );
}
