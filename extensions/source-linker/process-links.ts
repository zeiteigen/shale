import { commitResolutions } from "./resolution-graph";
import type { ShaleSDK, IngestEdgeInput, EvidenceInput } from "@shale/sdk";
import { bindConnectorSources } from './source-bindings';
import { createHash } from "node:crypto";
import { findKnnCandidatePairs } from "./knn-finder";
import { analyzeSourcePairWithLLM } from "./llm-analyzer";
import type { DiscoveredLink, ProcessLinksResult, RunOptions } from "./types";
import { sourceEntityName } from "../../lib/source-identity";
import { WATERMARK_KEY, BATCH_ID, readLinkBatch, completeLinkPairs, pairCheckpointId } from "./link-batch";
export { WATERMARK_KEY } from "./link-batch";

/**
 * Commits confirmed links into Shale's knowledge graph as entities and edges.
 * Stores reasons and similarity scores in edge metadata.
 *
 * @param links Array of confirmed links
 * @param sdk Scoped ShaleSDK instance
 * @param namespace Target graph namespace
 * @param bidirectional Whether to insert reciprocal edges
 */
export function commitLinksToGraph(
  links: DiscoveredLink[],
  sdk: ShaleSDK,
  namespace: string = "source-linker",
  bidirectional: boolean = true,
): number {
  if (links.length === 0) {
    return 0;
  }

  return sdk.database.transaction(() => {
  // Deduplicate entities
  const entityMap = new Map<string, { name: string; type: string }>();
  const addEntity = (name: string, type: string) => {
    const cleanName = name.trim();
    if (cleanName && !entityMap.has(cleanName)) {
      entityMap.set(cleanName, { name: cleanName, type });
    }
  };
  for (const link of links) {
    addEntity(sourceEntityName(link.sourceIdA), "Source");
    addEntity(sourceEntityName(link.sourceIdB), "Source");
  }

  const entities = Array.from(entityMap.values());
  const edges: IngestEdgeInput[] = [];
  const edgeKeys = new Set<string>();
  const addEdge = (edge: (typeof edges)[number]) => {
    const key = `${edge.source}\u0000${edge.target}\u0000${edge.relation}`;
    if (!edgeKeys.has(key) && edge.source !== edge.target) {
      edgeKeys.add(key);
      edges.push(edge);
    }
  };

  for (const link of links) {
    const evidence: EvidenceInput[] = [...(link.evidenceA ?? []),...(link.evidenceB ?? [])];
    const assertion = (source:string,target:string,relation:string) => ({
      id:`link:${createHash('sha256').update(JSON.stringify([namespace,source,target,relation,link.extractionRun,evidence])).digest('hex')}`,
      method:'llm',model:link.model,extractionRun:link.extractionRun,confidence:link.weight,
      status:'proposed' as const,evidence,
    });
    const metadata = {
      reason: link.reason,
      knnSimilarity: link.knnSimilarity,
      linkedAt: Date.now(),
      sourceIdA: link.sourceIdA,
      sourceTitleA: link.sourceTitleA,
      sourceIdB: link.sourceIdB,
      sourceTitleB: link.sourceTitleB,
    };

    // Forward edge
    addEdge({
      source: sourceEntityName(link.sourceIdA),
      target: sourceEntityName(link.sourceIdB),
      relation: link.relation,
      weight: link.weight,
      metadata,
      claim:assertion(sourceEntityName(link.sourceIdA),sourceEntityName(link.sourceIdB),link.relation),
    });

    // Reciprocal edge if bidirectional
    const reciprocal = sdk.graph.relations.reciprocal(link.relation);
    if (bidirectional && reciprocal) {
      addEdge({
        source: sourceEntityName(link.sourceIdB),
        target: sourceEntityName(link.sourceIdA),
        relation: reciprocal,
        weight: link.weight,
        metadata,
        claim:assertion(sourceEntityName(link.sourceIdB),sourceEntityName(link.sourceIdA),reciprocal),
      });
    }

  }

  const result = sdk.graph.ingest({
    namespace,
    entities,
    edges,
  });

  bindConnectorSources(sdk,namespace,new Map(links.flatMap(link => [
    [link.sourceIdA,result.entityMap[sourceEntityName(link.sourceIdA)]],
    [link.sourceIdB,result.entityMap[sourceEntityName(link.sourceIdB)]],
  ] as Array<[string,number]>)));

  return result.edgesInserted + links.reduce((count,link)=>count+commitResolutions(sdk,link,result.entityMap,namespace),0);
  })();
}

/**
 * Executes the complete two-phase source analysis and linking pipeline:
 * Phase 1: KNN candidate search + Chat model relationship analysis & reason generation.
 * Phase 2: Knowledge graph ingestion, checkpoint resolution, and watermark progression.
 *
 * @param sdk Scoped ShaleSDK instance
 * @param options Run options
 */
export async function processSourceLinks(
  sdk: ShaleSDK,
  options?: RunOptions,
): Promise<ProcessLinksResult> {
  return sdk.models.phase("chat", () =>
    analyzeAndCommitSourceLinks(sdk, options),
  );
}

async function analyzeAndCommitSourceLinks(
  sdk: ShaleSDK,
  options?: RunOptions,
): Promise<ProcessLinksResult> {
  const isForce =
    options?.forceAll ?? sdk.settings.get<boolean>("forceAll") ?? false;

  const lastWatermarkStr = sdk.state.getWatermark(WATERMARK_KEY);
  const lastWatermark = isForce ? 0 : Number(lastWatermarkStr ?? "0");

  sdk.logger.log(
    `Starting source-linker analysis (last watermark: ${lastWatermark}, forceAll: ${isForce})`,
  );

  let batch = readLinkBatch(sdk);
  const targetSources = batch ? [] : isForce
    ? sdk.context.getAllSources()
    : sdk.context.getSources({ since: lastWatermark });
  if (!batch && targetSources.length === 0) {
    return {
      sourcesAnalyzed: 0, candidatePairsEvaluated: 0, linksCreated: 0,
      edgesCommitted: 0, watermarkAdvancedTo: lastWatermark, checkpointsResolved: 0,
    };
  }
  if (!batch) {
    const pairs = await findKnnCandidatePairs(targetSources, sdk, {
      knnK: options?.knnK,
      minKnnSimilarity: options?.minKnnSimilarity,
      maxPairsPerRun: Number.MAX_SAFE_INTEGER,
    });
    batch = {
      type: "link_batch",
      sourcesAnalyzed: targetSources.length,
      maxUpdatedAt: targetSources.reduce((max, source) => Math.max(max, source.updated_at), lastWatermark),
      pairs,
    };
    sdk.saveCheckpoint(batch, { id: BATCH_ID, key: BATCH_ID });
  }
  const limit = options?.maxPairsPerRun ?? sdk.settings.get<number>("maxPairsPerRun") ?? 20;
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error("maxPairsPerRun must be a positive integer");
  const candidatePairs = batch.pairs.slice(0, limit);
  const discoveredLinks = (await sdk.models.mapChat(candidatePairs,
    pair => analyzeSourcePairWithLLM(pair, sdk))).filter((link): link is DiscoveredLink => !!link);
  const namespace = sdk.settings.get<string>("namespace") ?? "source-linker";
  const bidirectional = sdk.settings.get<boolean>("bidirectional") ?? true;
  const completed = new Set(candidatePairs.map(pairCheckpointId));
  const edgesCommitted = sdk.database.transaction(() => {
    const edges = commitLinksToGraph(discoveredLinks, sdk, namespace, bidirectional);
    for (const id of completed) sdk.deleteCheckpoint(id);
    completeLinkPairs(sdk, completed);
    return edges;
  })();
  sdk.logger.log(
    `Source linking: ${candidatePairs.length} pairs evaluated, ${edgesCommitted} edges committed; ${readLinkBatch(sdk)?.pairs.length ?? 0} pairs pending.`,
  );
  return {
    sourcesAnalyzed: batch.sourcesAnalyzed,
    candidatePairsEvaluated: candidatePairs.length,
    linksCreated: discoveredLinks.length,
    edgesCommitted,
    watermarkAdvancedTo: Number(sdk.state.getWatermark(WATERMARK_KEY) ?? "0"),
    checkpointsResolved: completed.size,
  };
}

export default processSourceLinks;
