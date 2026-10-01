import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import defaultDb from "../lib/db-init";
import { ensureGraphSchema } from "../lib/graph/schema";
import type { IngestGraphOptions, IngestGraphResult } from "./types";
import { GraphEntities } from "./graph/entities";
import { GraphRelations } from "./graph/relations";
import { GraphClaims } from "./graph/claims";
import { GraphEvidence } from "./graph/evidence";
import { GraphEvents } from "./graph/events";
import { GraphLifecycle } from "./graph/lifecycle";
import { GraphQuery } from "./graph/query";
import { GraphInference } from "./graph/inference";
import { GraphConflicts } from "./graph/conflicts";
import type { ClaimInput } from "./graph/types";

export class GraphIngestor {
  readonly entities: GraphEntities;
  readonly relations: GraphRelations;
  readonly claims: GraphClaims;
  readonly evidence: GraphEvidence;
  readonly events: GraphEvents;
  readonly lifecycle: GraphLifecycle;
  readonly query: GraphQuery;
  readonly inference: GraphInference;
  readonly conflicts: GraphConflicts;
  private readonly db: Database;
  constructor(readonly defaultNamespace = "default", database?: Database) {
    this.db = database ?? defaultDb;
    ensureGraphSchema(this.db);
    this.entities = new GraphEntities(this.db,defaultNamespace);
    this.relations = new GraphRelations(this.db,this.entities);
    this.evidence = new GraphEvidence(this.db);
    this.claims = new GraphClaims(this.db,defaultNamespace,this.relations,this.evidence);
    this.events = new GraphEvents(this.db,this.entities,this.claims);
    this.lifecycle = new GraphLifecycle(this.db,this.claims,this.relations);
    this.query = new GraphQuery(this.db,this.claims,this.entities);
    this.inference = new GraphInference(this.db,this.claims,this.relations);
    this.conflicts = new GraphConflicts(this.db,this.claims,this.relations);
  }

  ingestClaims(inputs: ClaimInput[]) {
    return this.db.transaction(() => inputs.map(input=>this.claims.add(input)))();
  }

  inspect(id: string) {
    return {...this.lifecycle.inspect(id),evidence:this.evidence.list(id)};
  }

  /** Existing extension API; edges are a compatibility projection of assertions. */
  ingest(options: IngestGraphOptions): IngestGraphResult {
    const namespace = options.namespace || this.defaultNamespace;
    return this.db.transaction(() => {
      const entityMap: Record<string,number> = {};
      const ambiguous = new Set<string>();
      const map = (key:string,id:number) => {
        if (entityMap[key] !== undefined && entityMap[key] !== id) ambiguous.add(key);
        entityMap[key] = id;
      };
      for (const entity of options.entities) {
        const ns = entity.namespace || namespace;
        const id = entity.stableId
          ? this.entities.create({...entity,namespace:ns}).id
          : this.db.query<{id:number}, [string,string,string]>(`INSERT INTO entities(namespace,name,type) VALUES(?,?,?)
              ON CONFLICT(namespace,name) DO UPDATE SET type=excluded.type RETURNING id`).get(ns,entity.name,entity.type)!.id;
        map(entity.name,id); map(`${ns}:${entity.name}`,id);
        if (entity.id !== undefined) map(String(entity.id),id);
      }
      const resolve = (identifier:string|number) => {
        const key = String(identifier);
        if (ambiguous.has(key)) throw new Error(`Ambiguous graph entity ${key}; use a qualified name or stable ID`);
        if (entityMap[key] !== undefined) return entityMap[key];
        if (typeof identifier === 'number') return this.entities.get(identifier).id;
        const matches = this.entities.resolve(identifier,'',namespace);
        if (!matches.length) throw new Error(`Graph edge references unknown entity "${identifier}" in namespace "${namespace}"`);
        if (matches.length !== 1) throw new Error(`Ambiguous graph entity "${identifier}" in namespace "${namespace}"`);
        return matches[0].id;
      };
      const hasMetadata = this.db.query<{name:string}, []>('PRAGMA table_info(edges)').all().some(c=>c.name==='metadata');
      for (const edge of options.edges) {
        const subject=resolve(edge.source),object=resolve(edge.target);
        const metadata = typeof edge.metadata === 'string' ? {legacyMetadata:edge.metadata} : edge.metadata ?? {};
        const id = edge.claim?.id ?? `edge:${createHash('sha256').update(JSON.stringify([namespace,subject,object,edge.relation,edge.weight ?? 1,metadata,edge.claim])).digest('hex')}`;
        if (!this.db.query('SELECT 1 FROM graph_claims WHERE id=?').get(id)) {
          this.claims.add({...edge.claim,id,namespace:edge.claim?.namespace ?? namespace,subject,object,predicate:edge.relation,
            strength:edge.claim?.strength ?? edge.weight ?? 1,qualifiers:{...JSON.parse(JSON.stringify(metadata)),...edge.claim?.qualifiers},
            status:edge.claim?.status ?? 'accepted'});
        }
        if (edge.claim?.polarity === -1) continue;
        const params: (string|number|null)[] = [subject,object,edge.relation,edge.weight ?? 1];
        if (hasMetadata) params.push(edge.metadata === undefined ? null : typeof edge.metadata === 'string' ? edge.metadata : JSON.stringify(edge.metadata));
        this.db.query(`INSERT INTO edges(source_entity_id,target_entity_id,relation,weight${hasMetadata ? ',metadata' : ''})
          VALUES(?,?,?,?${hasMetadata ? ',?' : ''}) ON CONFLICT(source_entity_id,target_entity_id,relation)
          DO UPDATE SET weight=excluded.weight${hasMetadata ? ',metadata=excluded.metadata' : ''}`).run(...params);
      }
      return {namespace,entitiesInserted:options.entities.length,edgesInserted:options.edges.length,entityMap};
    })();
  }
}
export default GraphIngestor;
