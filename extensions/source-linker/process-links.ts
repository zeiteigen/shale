import type { ShaleSDK, Source } from "@shale/sdk";
import { findKnnCandidatePairs } from "./knn-finder";
import { analyzeSourcePairWithLLM } from "./llm-analyzer";
import type {
  DiscoveredLink,
  ProcessLinksResult,
  RunOptions,
} from "./types";

export const WATERMARK_KEY = "last_source_update";

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

  // Deduplicate entities
  const entityMap = new Map<string, { name: string; type: string }>();
  const addEntity = (name: string, type: string) => {
    const cleanName = name.trim();
    if (cleanName && !entityMap.has(cleanName)) {
      entityMap.set(cleanName, { name: cleanName, type });
    }
  };
  for (const link of links) {
    addEntity(link.sourceTitleA, "Source");
    addEntity(link.sourceTitleB, "Source");
    for (const resolution of link.entityResolutions ?? []) {
      addEntity(resolution.canonicalName, resolution.entityType || "Entity");
      for (const mention of [...resolution.mentionsA, ...resolution.mentionsB]) {
        if (
          mention.localeCompare(resolution.canonicalName, undefined, {
            sensitivity: "accent",
          }) !== 0
        ) {
          addEntity(mention, "EntityAlias");
        }
      }
    }
  }

  const entities = Array.from(entityMap.values());
  const edges: Array<{
    source: string;
    target: string;
    relation: string;
    weight: number;
    metadata?: Record<string, any>;
  }> = [];
  const edgeKeys = new Set<string>();
  const addEdge = (edge: (typeof edges)[number]) => {
    const key = `${edge.source}\u0000${edge.target}\u0000${edge.relation}`;
    if (!edgeKeys.has(key) && edge.source !== edge.target) {
      edgeKeys.add(key);
      edges.push(edge);
    }
  };

  for (const link of links) {
    const metadata = {
      reason: link.reason,
      knnSimilarity: link.knnSimilarity,
      linkedAt: Date.now(),
    };

    // Forward edge
    addEdge({
      source: link.sourceTitleA,
      target: link.sourceTitleB,
      relation: link.relation,
      weight: link.weight,
      metadata,
    });

    // Reciprocal edge if bidirectional
    if (bidirectional) {
      addEdge({
        source: link.sourceTitleB,
        target: link.sourceTitleA,
        relation: link.relation,
        weight: link.weight,
        metadata,
      });
    }

    for (const resolution of link.entityResolutions ?? []) {
      const resolutionMetadata = {
        reason: resolution.reason,
        confidence: resolution.confidence,
        canonicalName: resolution.canonicalName,
        linkedAt: metadata.linkedAt,
      };

      if (resolution.mentionsA.length > 0) {
        addEdge({
          source: link.sourceTitleA,
          target: resolution.canonicalName,
          relation: "MENTIONS_ENTITY",
          weight: resolution.confidence,
          metadata: { ...resolutionMetadata, mentions: resolution.mentionsA },
        });
      }
      if (resolution.mentionsB.length > 0) {
        addEdge({
          source: link.sourceTitleB,
          target: resolution.canonicalName,
          relation: "MENTIONS_ENTITY",
          weight: resolution.confidence,
          metadata: { ...resolutionMetadata, mentions: resolution.mentionsB },
        });
      }

      for (const mention of [...resolution.mentionsA, ...resolution.mentionsB]) {
        if (
          mention.localeCompare(resolution.canonicalName, undefined, {
            sensitivity: "accent",
          }) === 0
        ) {
          continue;
        }
        addEdge({
          source: mention,
          target: resolution.canonicalName,
          relation: "COREFERS_TO",
          weight: resolution.confidence,
          metadata: resolutionMetadata,
        });
      }
    }
  }

  const result = sdk.graph.ingest({
    namespace,
    entities,
    edges,
  });

  return result.edgesInserted;
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
  const isForce =
    options?.forceAll ??
    sdk.settings.get<boolean>("forceAll") ??
    false;

  const lastWatermarkStr = sdk.state.getWatermark(WATERMARK_KEY);
  const lastWatermark = isForce ? 0 : Number(lastWatermarkStr ?? "0");

  sdk.logger.log(
    `Starting source-linker analysis (last watermark: ${lastWatermark}, forceAll: ${isForce})`,
  );

  // 1. Discover updated/new sources since watermark
  const targetSources = isForce
    ? sdk.context.getAllSources()
    : sdk.context.getSources({ since: lastWatermark });

  if (targetSources.length === 0) {
    sdk.logger.log("No new or updated sources since last watermark.");
    return {
      sourcesAnalyzed: 0,
      candidatePairsEvaluated: 0,
      linksCreated: 0,
      edgesCommitted: 0,
      watermarkAdvancedTo: lastWatermark,
      checkpointsResolved: 0,
    };
  }

  let maxUpdatedAt = lastWatermark;
  for (const s of targetSources) {
    if (s.updated_at > maxUpdatedAt) {
      maxUpdatedAt = s.updated_at;
    }
  }

  sdk.logger.log(
    `Found ${targetSources.length} target source(s) to analyze for links.`,
  );

  // === Phase 1: KNN Candidate Search + Chat Model Analysis ===
  sdk.logger.log(
    `=== Phase 1: KNN Candidate Discovery & LLM Analysis ===`,
  );

  const candidatePairs = await findKnnCandidatePairs(
    targetSources,
    sdk,
    {
      knnK: options?.knnK,
      minKnnSimilarity: options?.minKnnSimilarity,
      maxPairsPerRun: options?.maxPairsPerRun,
    },
  );

  sdk.logger.log(
    `Discovered ${candidatePairs.length} candidate source pair(s) via KNN.`,
  );

  const discoveredLinks: DiscoveredLink[] = [];

  for (const pair of candidatePairs) {
    const link = await analyzeSourcePairWithLLM(pair, sdk);
    if (link) {
      discoveredLinks.push(link);
    }
  }

  // === Phase 2: Ingestion & Knowledge Graph Commit ===
  sdk.logger.log(
    `=== Phase 2: Ingestion & Graph Edges Persistence ===`,
  );

  const namespace =
    sdk.settings.get<string>("namespace") ?? "source-linker";
  const bidirectional =
    sdk.settings.get<boolean>("bidirectional") ?? true;

  const edgesCommitted = commitLinksToGraph(
    discoveredLinks,
    sdk,
    namespace,
    bidirectional,
  );

  // Resolve and clean up all link checkpoints
  const queuedCheckpoints = sdk.checkpoint.getQueue<any>();
  let checkpointsResolved = 0;
  for (const cp of queuedCheckpoints) {
    if (cp.id.startsWith("link_analysis:")) {
      sdk.checkpoint.delete(cp.id);
      checkpointsResolved++;
    }
  }

  // Advance watermark
  if (maxUpdatedAt > lastWatermark) {
    sdk.state.setWatermark(String(maxUpdatedAt), WATERMARK_KEY);
    sdk.logger.log(`Watermark advanced to ${maxUpdatedAt}.`);
  }

  sdk.logger.log(
    `Source linking complete: ${targetSources.length} sources analyzed, ${candidatePairs.length} candidate pairs evaluated, ${discoveredLinks.length} links created, ${edgesCommitted} edges committed.`,
  );

  return {
    sourcesAnalyzed: targetSources.length,
    candidatePairsEvaluated: candidatePairs.length,
    linksCreated: discoveredLinks.length,
    edgesCommitted,
    watermarkAdvancedTo: maxUpdatedAt,
    checkpointsResolved,
  };
}

export default processSourceLinks;
