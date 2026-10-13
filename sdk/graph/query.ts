import type { Database } from "bun:sqlite";
import type { ClaimFilter, GraphPath, GraphTraversal, TraversalOptions } from "./types";
import type { GraphClaims } from "./claims";
import type { GraphEntities } from "./entities";

export class GraphQuery {
  constructor(private db: Database, private claims: GraphClaims, private entities: GraphEntities) {}

  /** Index-backed breadth-first traversal, with explicit work and output budgets. */
  traverse(options: TraversalOptions): GraphTraversal {
    const maxDepth = bounded(options.maxDepth ?? 2,0,8);
    const maxNodes = bounded(options.maxNodes ?? 100,1,500);
    const maxClaims = bounded(options.maxClaims ?? 500,1,2000);
    const start = this.entities.canonical(options.start).id;
    const historical = options.knownAt !== undefined || options.statuses?.some(status => !['accepted','proposed','disputed'].includes(status));
    const retired = historical ? new Set<number>() : new Set(this.db.query<{entity_id:number},[]>(
      'SELECT entity_id FROM graph_entity_retirements').all().map(row => row.entity_id));
    if (retired.has(start)) return {entities:[],claims:[],paths:[],truncated:false};
    const paths = new Map<number,GraphPath>([[start,{entityId:start,depth:0,entityIds:[start],claimIds:[]}]]);
    const retained = new Map<string,ReturnType<GraphClaims['get']>>();
    const queue = [start]; let examined=0; let truncated=false;
    for (let cursor=0; cursor<queue.length; cursor++) {
      const id = queue[cursor]; const path = paths.get(id)!;
      if (path.depth >= maxDepth) continue;
      const members = this.db.query<{id:number}, [number]>(`WITH RECURSIVE members(id) AS (
        SELECT ? UNION SELECT e.id FROM entities e JOIN members m ON e.canonical_id=m.id
      ) SELECT id FROM members LIMIT 501`).all(id);
      if (members.length > 500) { truncated=true; break; }
      for (const member of members) {
        const {minConfidence: _minConfidence, ...claimOptions} = options;
        const filter: ClaimFilter = {...claimOptions,entityId:member.id,subject:undefined,
          statuses:options.statuses ?? ['accepted'],polarity:1,predicates:options.predicates,limit:Math.min(1000,maxClaims-examined+1),offset:0};
        const candidates = this.claims.list(filter);
        if (candidates.length === 1000) truncated=true;
        for (const claim of candidates) {
          if (retained.has(claim.id)) continue;
          if (++examined > maxClaims) { truncated=true; break; }
          if (claim.object === undefined) continue;
          if (claim.status === 'proposed' && claim.confidence != null && claim.confidence < (options.minConfidence ?? 0)) continue;
          const source = this.entities.canonical(claim.subject).id;
          const target = this.entities.canonical(claim.object).id;
          const direction = options.direction ?? 'out';
          if (direction === 'out' && source !== id || direction === 'in' && target !== id) continue;
          const neighbor = source === id ? target : source;
          if (retired.has(neighbor)) continue;
          if (!paths.has(neighbor)) {
            if (paths.size >= maxNodes) { truncated=true; continue; }
            paths.set(neighbor,{entityId:neighbor,depth:path.depth+1,entityIds:[...path.entityIds,neighbor],claimIds:[...path.claimIds,claim.id]});
            queue.push(neighbor);
          }
          retained.set(claim.id,claim);
        }
        if (examined > maxClaims) break;
      }
      if (examined > maxClaims) break;
    }
    return {entities:[...paths.keys()].map(id=>this.entities.get(id)),claims:[...retained.values()],paths:[...paths.values()],truncated};
  }
  path(options: TraversalOptions & {target:number}) {
    const result = this.traverse(options);
    return {path:result.paths.find(p=>p.entityId === this.entities.canonical(options.target).id),truncated:result.truncated};
  }
}

function bounded(value: number, min: number, max: number) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Graph query budget must be an integer between ${min} and ${max}`);
  return value;
}
