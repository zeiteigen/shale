import type { Database } from "bun:sqlite";
import { retrievalSeeds } from "./retrieval-seeds";
import type { ChunkSearchResult, BM25SearchOptions } from "../types";
import type { GraphIngestor } from "../graph";
import type { Evidence, GraphTraversal, TraversalOptions } from "./types";

export interface GraphSearchOptions extends BM25SearchOptions {
  mode?: 'bm25'; maxSeeds?: number; minScore?: number; maxRetrieved?:number;
  graph?: Omit<TraversalOptions,'start'>;
}
export interface GraphSearchResult {
  results: ChunkSearchResult[]; neighborhoods: GraphTraversal[]; evidence: Evidence[];
  relatedPassages: Array<{claimId:string;revisionId:number;chunkIndex:number;text:string}>; truncated: boolean;
}

/** Expand retrieved passages into bounded, explainable graph neighborhoods. */
export function expandGraphResults(db: Database, graph: GraphIngestor, results: ChunkSearchResult[], options: GraphSearchOptions): GraphSearchResult {
  const maxSeeds = options.maxSeeds ?? 5;
  if (!Number.isInteger(maxSeeds) || maxSeeds < 0 || maxSeeds > 20) throw new Error('maxSeeds must be between 0 and 20');
  const maxRetrieved=options.maxRetrieved ?? 100;
  if (!Number.isInteger(maxRetrieved) || maxRetrieved < 1 || maxRetrieved > 100) throw new Error('maxRetrieved must be between 1 and 100');
  const boundedResults=results.slice(0,maxRetrieved);
  if(maxSeeds===0) return {results:boundedResults,neighborhoods:[],evidence:[],relatedPassages:[],truncated:results.length>boundedResults.length};
  const seeds = retrievalSeeds(db, graph, boundedResults);
  const selected = [...seeds].slice(0,maxSeeds);
  let remainingNodes=options.graph?.maxNodes ?? 50;
  let remainingClaims=options.graph?.maxClaims ?? 100;
  const neighborhoods = selected.map(start=>{
    if(remainingNodes===0 || remainingClaims===0) return {entities:[],claims:[],paths:[],truncated:true} as GraphTraversal;
    const traversal=graph.query.traverse({...options.graph,start,
      maxNodes:remainingNodes,maxClaims:remainingClaims,direction:options.graph?.direction ?? 'both'});
    remainingNodes=Math.max(0,remainingNodes-traversal.entities.length);
    remainingClaims=Math.max(0,remainingClaims-traversal.claims.length);
    return traversal;
  });
  const claimIds = new Set<string>();
  for(const n of neighborhoods) for(const c of n.claims) { if(claimIds.size >= (options.graph?.maxClaims ?? 100)) break; claimIds.add(c.id); }
  const allEvidence = [...claimIds].flatMap(id=>graph.evidence.list(id)).filter(e=>e.withdrawnAt===undefined);
  const evidence=allEvidence.slice(0,100);
  const passages = new Map<string,GraphSearchResult['relatedPassages'][number]>();
  for (const item of evidence) {
    if (item.chunkIndex === undefined) continue;
    const row = db.query<{text_content:string}, [number,number]>(
      'SELECT text_content FROM graph_revision_chunks WHERE revision_id=? AND chunk_index=?').get(item.revisionId,item.chunkIndex);
    const key=`${item.revisionId}:${item.chunkIndex}`;
    if (row && !passages.has(key)) passages.set(key,
      {claimId:item.claimId,revisionId:item.revisionId,chunkIndex:item.chunkIndex,text:row.text_content.slice(0,600)});
  }
  return {results:boundedResults,neighborhoods,evidence,relatedPassages:[...passages.values()].slice(0,100),
    truncated:results.length>boundedResults.length || seeds.size>maxSeeds || neighborhoods.some(n=>n.truncated) || allEvidence.length>evidence.length || passages.size>100};
}
