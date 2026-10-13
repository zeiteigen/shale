import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShaleSDK } from "../../sdk";
import type { ClaimStatus } from "../../sdk/graph/types";
import { resolveEntityId, formatToolResponse, formatToolError } from "../types";
import { registerMemoryTools } from "./memory";
import { EpisodeStore } from "../../sdk/graph/episodes";

const ClaimStatusEnum = z.enum([
  "proposed",
  "accepted",
  "rejected",
  "disputed",
  "stale",
  "retracted",
  "superseded",
]);

export function registerSearchTools(mcp: McpServer, sdk: ShaleSDK) {
  const graph = sdk.graph;
  registerMemoryTools(mcp, sdk);

  // ==========================================
  // 1. Search & Traversal Tools
  // ==========================================

  mcp.tool(
    "search_graph",
    "Search retained source memories with BM25. Returns up to five distinct sources by default, with one summary or snippet preview and stable memory citation IDs per source, expanded into graph neighborhoods (accepted links plus confident proposed ones; check each claim's status). Use list_episodes/get_episode for cross-source stories. Original full source content may have been discarded.",
    {
      query: z.string().describe("Search query text or keywords"),
      mode: z
        .enum(["bm25"])
        .default("bm25")
        .describe("Full-text retrieval mode"),
      limit: z.number().int().min(1).max(100).default(5).describe("Maximum distinct sources to return"),
      offset: z.number().int().min(0).default(0).describe("Source result offset for continuation"),
      origin: z.string().optional().describe("Filter by source origin"),
      type: z.string().optional().describe("Filter by source type"),
      sourceId: z.string().optional().describe("Filter by source ID or URI"),
      maxChars: z.number().int().min(1000).max(64000).default(16000).describe("Maximum serialized response size"),
      maxSeeds: z
        .number()
        .int()
        .min(0)
        .max(20)
        .default(3)
        .describe("Maximum hits to expand into graph neighborhoods; zero disables graph expansion"),
      maxDepth: z.number().int().min(1).max(5).default(2).describe("Neighborhood traversal depth"),
      maxNeighbors: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Maximum neighbor entities to include per seed"),
      minScore: z.number().min(0).default(0.01).describe("Minimum chunk search score threshold"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (args) => {
      try {
        const grouped = sdk.memory.search({query:args.query,limit:args.limit,offset:args.offset,origin:args.origin,type:args.type,sourceId:args.sourceId});
        const neighborhoods=[];
        const evidence=new Map<string, unknown>();
        const passages=new Map<string, unknown>();
        let remainingNodes=args.maxNeighbors;
        let remainingClaims=100;
        let graphTruncated=false;
        if(args.maxSeeds>0) for(const hit of grouped.hits.slice(0,args.maxSeeds)) {
          if(remainingNodes<=0 || remainingClaims<=0) { graphTruncated=true; break; }
          const result=await sdk.search.graph({query:args.query,mode:args.mode,limit:100,maxSeeds:1,minScore:args.minScore,
            filterSourceId:hit.sourceId,maxRetrieved:100,graph:{maxDepth:args.maxDepth,maxNodes:remainingNodes,maxClaims:remainingClaims}});
          neighborhoods.push(...result.neighborhoods);
          remainingNodes=Math.max(0,remainingNodes-result.neighborhoods.reduce((n,item)=>n+item.entities.length,0));
          remainingClaims=Math.max(0,remainingClaims-result.neighborhoods.reduce((n,item)=>n+item.claims.length,0));
          for(const item of result.evidence) evidence.set(item.id, item);
          for(const item of result.relatedPassages) passages.set(`${item.revisionId}:${item.chunkIndex}`,item);
          graphTruncated ||= result.truncated;
        }
        if(grouped.hits.length>args.maxSeeds && args.maxSeeds>0) graphTruncated=true;
        // Which of the user's episodes each hit belongs to: the story around the passage.
        const store=new EpisodeStore(sdk.database,sdk.graph);
        const episodes=new Map<number,{id:number;title:string;status:string;summary:string;sourceIds:string[]}>();
        for(const hit of grouped.hits) for(const id of store.ofSource(hit.sourceId)) {
          const known=episodes.get(id);
          if(known) {known.sourceIds.push(hit.sourceId);continue;}
          const episode=store.get(id);
          if(episode) episodes.set(id,{id,title:episode.title,status:episode.status,summary:episode.summary,sourceIds:[hit.sourceId]});
        }
        return formatToolResponse({...grouped, episodes:[...episodes.values()], neighborhoods, evidence:[...evidence.values()].slice(0,100), relatedPassages:[...passages.values()].slice(0,100), graphTruncated},args.maxChars);
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  mcp.tool(
    "traverse_graph",
    "Performs a bounded breadth-first traversal starting from an entity, exploring connected claims and entities.",
    {
      start: z
        .union([z.number().int(), z.string()])
        .describe("Start entity numeric ID or entity name"),
      maxDepth: z
        .number()
        .int()
        .min(1)
        .max(8)
        .default(2)
        .describe("Maximum traversal depth (default: 2)"),
      maxNodes: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(20)
        .describe("Maximum nodes to retain (default: 20)"),
      maxClaims: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(30)
        .describe("Maximum claims to examine (default: 30)"),
      maxChars: z.number().int().min(1000).max(64000).default(16000).describe("Maximum serialized response size"),
      direction: z
        .enum(["out", "in", "both"])
        .default("both")
        .describe("Direction of edges to follow: out, in, or both"),
      predicates: z
        .array(z.string())
        .optional()
        .describe("Optional filter by predicate names"),
      context: z.string().optional().describe("Optional context scope filter"),
      statuses: z
        .array(ClaimStatusEnum)
        .optional()
        .describe("Allowed claim statuses (defaults to accepted)"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (args) => {
      try {
        const startId = resolveEntityId(sdk, args.start, "start entity");
        const result = graph.query.traverse({
          start: startId,
          maxDepth: args.maxDepth,
          maxNodes: args.maxNodes,
          maxClaims: args.maxClaims,
          direction: args.direction,
          predicates: args.predicates,
          context: args.context,
          statuses: args.statuses as ClaimStatus[] | undefined,
        });
        return formatToolResponse(compactTraversal(result,args.maxNodes,args.maxClaims,args.maxChars),args.maxChars);
      } catch (err) {
        return formatToolError(err);
      }
    },
  );

  mcp.tool(
    "find_path",
    "Finds the shortest directed or undirected path between two entities in the knowledge graph.",
    {
      start: z
        .union([z.number().int(), z.string()])
        .describe("Start entity numeric ID or entity name"),
      target: z
        .union([z.number().int(), z.string()])
        .describe("Target entity numeric ID or entity name"),
      maxDepth: z
        .number()
        .int()
        .min(1)
        .max(8)
        .default(4)
        .describe("Maximum search depth"),
      direction: z
        .enum(["out", "in", "both"])
        .default("both")
        .describe("Edge direction: out, in, or both"),
      predicates: z
        .array(z.string())
        .optional()
        .describe("Optional filter by allowed predicate names"),
      context: z.string().optional().describe("Optional context scope"),
      statuses: z
        .array(ClaimStatusEnum)
        .optional()
        .describe("Allowed claim statuses (default: accepted)"),
    },
    { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async (args) => {
      try {
        const startId = resolveEntityId(sdk, args.start, "start entity");
        const targetId = resolveEntityId(sdk, args.target, "target entity");
        const result = graph.query.path({
          start: startId,
          target: targetId,
          maxDepth: args.maxDepth,
          direction: args.direction,
          predicates: args.predicates,
          context: args.context,
          statuses: args.statuses as ClaimStatus[] | undefined,
        });
        return formatToolResponse(result);
      } catch (err) {
        return formatToolError(err);
      }
    },
  );
}

export function compactTraversal(result:import('../../sdk/graph/types').GraphTraversal,maxNodes:number,maxClaims:number,maxChars:number) {
  const boundedValue=(value:unknown) => {
    if(value===undefined) return undefined;
    const encoded=JSON.stringify(value);
    return encoded.length<=400 ? value : {valuePreview:encoded.slice(0,380),valueTruncated:true};
  };
  const output:any={
    entities:result.entities.map(({id,name,type,namespace})=>({id,name,type,namespace})),
    claims:result.claims.map(({id,subject,predicate,object,value,status,context})=>({id,subject,predicate,object,value:boundedValue(value),status,context})),
    paths:result.paths.map(({entityId,depth,entityIds,claimIds})=>({entityId,depth,entityIds,claimIds})),
    counts:{entities:result.entities.length,claims:result.claims.length,paths:result.paths.length},
    limits:{maxNodes,maxClaims},truncated:result.truncated,
    continuationGuidance:'To explore another part of the graph, change the start entity, direction, predicates, context, statuses, or depth; traversal does not expose an offset cursor.',
  };
  let omitted={entities:0,claims:0,paths:0};
  const fits=()=>JSON.stringify(output).length<=maxChars;
  while(!fits()) {
    const key=['paths','claims','entities'].find(candidate=>output[candidate].length>0);
    if(!key) break;
    output[key].pop(); omitted[key as keyof typeof omitted]++;
    output.truncated=true;
  }
  if(omitted.entities||omitted.claims||omitted.paths) output.omitted=omitted;
  return fits() ? output : {entities:[],claims:[],paths:[],counts:output.counts,limits:output.limits,truncated:true,
    omitted:{entities:result.entities.length,claims:result.claims.length,paths:result.paths.length},continuationGuidance:output.continuationGuidance};
}
