import type { ShaleSDK, Source } from "@shale/sdk";
import type { SourceCandidatePair } from "./types";
import type { SourceLinkerSettings } from "./settings.types";

export interface KnnFinderOptions {
  knnK?: number;
  minKnnSimilarity?: number;
  maxPairsPerRun?: number;
}

/**
 * Discovers candidate source pairs by executing K-Nearest Neighbors (KNN) vector
 * search across chunk embeddings, aggregating chunk similarities to source level.
 *
 * @param targetSources Sources that were created or modified since last watermark
 * @param sdk Scoped ShaleSDK instance
 * @param options Optional overrides for KNN parameters
 */
export async function findKnnCandidatePairs(
  targetSources: Source[],
  sdk: ShaleSDK,
  options?: KnnFinderOptions,
): Promise<SourceCandidatePair[]> {
  const k =
    options?.knnK ??
    sdk.settings.get<number>("knnK") ??
    5;
  const minSimilarity =
    options?.minKnnSimilarity ??
    sdk.settings.get<number>("minKnnSimilarity") ??
    0.65;
  const maxPairs =
    options?.maxPairsPerRun ??
    sdk.settings.get<number>("maxPairsPerRun") ??
    20;

  if (targetSources.length === 0) {
    return [];
  }

  // Load all sources to map neighbor source IDs to source records
  const allSources = sdk.context.getAllSources();
  const sourceMap = new Map<string, Source>();
  for (const s of allSources) {
    sourceMap.set(s.id, s);
  }

  // Map of canonical pair key -> SourceCandidatePair tracking max similarity
  const candidatePairsMap = new Map<
    string,
    {
      sourceA: Source;
      sourceB: Source;
      maxSimilarity: number;
      matchedChunkIds: Set<number>;
    }
  >();

  for (const source of targetSources) {
    // Retrieve chunks for the target source
    const chunks = sdk.context.getRecentChunks(source.id, 50);
    if (chunks.length === 0) {
      continue;
    }

    for (const chunk of chunks) {
      try {
        const neighbors = await sdk.search.vector({
          chunkId: chunk.id,
          limit: Math.max(k * 2, 10),
          excludeSelf: true,
          minSimilarity,
        });

        for (const neighbor of neighbors) {
          if (!neighbor.source_id || neighbor.source_id === source.id) {
            continue;
          }

          const otherSource = sourceMap.get(neighbor.source_id);
          if (!otherSource) {
            continue;
          }

          const similarity = neighbor.cosineSimilarity ?? 0;
          if (similarity < minSimilarity) {
            continue;
          }

          // Canonical key based on sorted source IDs to avoid duplicate A-B and B-A
          const pairKey = [source.id, otherSource.id].sort().join("<->");
          const existing = candidatePairsMap.get(pairKey);

          if (existing) {
            if (similarity > existing.maxSimilarity) {
              existing.maxSimilarity = similarity;
            }
            existing.matchedChunkIds.add(chunk.id);
            existing.matchedChunkIds.add(neighbor.id);
          } else {
            // Keep sourceA as the target source (or deterministic ordering)
            const [sourceA, sourceB] =
              source.id < otherSource.id
                ? [source, otherSource]
                : [otherSource, source];

            candidatePairsMap.set(pairKey, {
              sourceA,
              sourceB,
              maxSimilarity: similarity,
              matchedChunkIds: new Set([chunk.id, neighbor.id]),
            });
          }
        }
      } catch (err: any) {
        if (!String(err?.message).includes("not found or has no embedding")) throw err;
        // If chunk has no embedding in vector_index yet, skip chunk
        sdk.logger.debug(
          `KNN search skipped for chunk ${chunk.id} in source "${source.title}":`,
          err?.message || err,
        );
      }
    }
  }

  // Convert map to array, sort descending by similarity score, and limit
  const candidates: SourceCandidatePair[] = Array.from(
    candidatePairsMap.values(),
  ).map((item) => ({
    sourceA: item.sourceA,
    sourceB: item.sourceB,
    knnSimilarity: item.maxSimilarity,
    matchedChunkIds: Array.from(item.matchedChunkIds),
  }));

  candidates.sort((a, b) => b.knnSimilarity - a.knnSimilarity);

  return candidates.slice(0, maxPairs);
}

export default findKnnCandidatePairs;
