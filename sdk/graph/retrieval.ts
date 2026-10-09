import type { Database } from "bun:sqlite";
import { retrievalSeeds } from "./retrieval-seeds";
import type { ChunkSearchResult, BM25SearchOptions } from "../types";
import type { GraphIngestor } from "../graph";
import type { Evidence, GraphTraversal, TraversalOptions } from "./types";

export interface GraphSearchOptions extends BM25SearchOptions {
  mode?: 'bm25'; maxSeeds?: number; minScore?: number;
  graph?: Omit<TraversalOptions,'start'>;
}
export interface GraphSearchResult {
  results: ChunkSearchResult[]; neighborhoods: GraphTraversal[]; evidence: Evidence[];
  relatedPassages: Array<{claimId:string;revisionId:number;chunkIndex:number;text:string}>; truncated: boolean;
}

/** Expand retrieved passages into bounded, explainable graph neighborhoods. */
export function expandGraphResults(db: Database, graph: GraphIngestor, results: ChunkSearchResult[], options: GraphSearchOptions): GraphSearchResult {
  const maxSeeds = options.maxSeeds ?? 5;
  if (!Number.isInteger(maxSeeds) || maxSeeds < 1 || maxSeeds > 20) throw new Error('maxSeeds must be between 1 and 20');
  const seeds = retrievalSeeds(db, graph, results);
  const selected = [...seeds].slice(0,maxSeeds);
  const neighborhoods = selected.map(start=>graph.query.traverse({...options.graph,start,
    maxNodes:options.graph?.maxNodes ?? 50,maxClaims:options.graph?.maxClaims ?? 100,direction:options.graph?.direction ?? 'both'}));
  const claimIds = new Set(neighborhoods.flatMap(n=>n.claims.map(c=>c.id)));
  const evidence = [...claimIds].flatMap(id=>graph.evidence.list(id)).filter(e=>e.withdrawnAt===undefined);
  const passages = new Map<string,GraphSearchResult['relatedPassages'][number]>();
  for (const item of evidence) {
    if (item.chunkIndex === undefined) continue;
    const row = db.query<{text_content:string}, [number,number]>(
      'SELECT text_content FROM graph_revision_chunks WHERE revision_id=? AND chunk_index=?').get(item.revisionId,item.chunkIndex);
    if (row) passages.set(`${item.claimId}:${item.revisionId}:${item.chunkIndex}`,
      {claimId:item.claimId,revisionId:item.revisionId,chunkIndex:item.chunkIndex,text:row.text_content});
  }
  return {results,neighborhoods,evidence,relatedPassages:[...passages.values()],
    truncated:seeds.size>maxSeeds || neighborhoods.some(n=>n.truncated)};
}
