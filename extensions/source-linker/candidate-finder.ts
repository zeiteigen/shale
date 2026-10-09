import { extractKeywords, type ShaleSDK, type Source } from "@shale/sdk";
import type { SourceCandidatePair } from "./types";

export interface CandidateFinderOptions {
  candidatesPerChunk?: number;
  maxPairsPerRun?: number;
}

/** Rank cross-source candidates by full-text matches; the LLM reviews relationships. */
export async function findCandidatePairs(sources: Source[], sdk: ShaleSDK, options?: CandidateFinderOptions): Promise<SourceCandidatePair[]> {
  const limit = options?.candidatesPerChunk ?? sdk.settings.get<number>("candidatesPerChunk", 5);
  const maxPairs = options?.maxPairsPerRun ?? sdk.settings.get<number>("maxPairsPerRun", 20);
  if (!Number.isInteger(limit) || limit < 1 || !Number.isInteger(maxPairs) || maxPairs < 1)
    throw new Error("Candidate limits must be positive integers");
  const sourceMap = new Map(sdk.context.getAllSources().map(source => [source.id, source]));
  const pairs = new Map<string, SourceCandidatePair>();
  let searches = 0;
  for (const source of sources) {
    for (const chunk of sdk.context.getRecentChunks(source.id, 50)) {
      if (++searches % 8 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
      const keywords = extractKeywords(chunk.text_content).slice(0, 32);
      if (!keywords.length) continue;
      const matches = await sdk.search.bm25({ keywords, limit, excludeSourceId: source.id });
      let selected = 0;
      for (const match of matches) {
        if (match.source_id === source.id) continue;
        const other = sourceMap.get(match.source_id);
        if (!other) continue;
        const key = [source.id, other.id].sort().join("<->");
        const existing = pairs.get(key);
        if (existing) {
          existing.textScore = Math.max(existing.textScore, match.score);
          existing.matchedChunkIds = [...new Set([...existing.matchedChunkIds, chunk.id, match.id])];
        } else {
          const [sourceA, sourceB] = source.id < other.id ? [source, other] : [other, source];
          pairs.set(key, { sourceA, sourceB, textScore: match.score, matchedChunkIds: [chunk.id, match.id] });
        }
        if (++selected >= limit) break;
      }
    }
  }
  return [...pairs.values()].sort((a, b) => b.textScore - a.textScore).slice(0, maxPairs);
}
