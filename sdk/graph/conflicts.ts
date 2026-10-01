import type { Database } from "bun:sqlite";
import type { ClaimFilter } from "./types";
import type { GraphClaims } from "./claims";
import type { GraphRelations } from "./relations";

export class GraphConflicts {
  constructor(private db: Database, private claims: GraphClaims, private relations: GraphRelations) {}
  find(filter: ClaimFilter = {}) {
    const claims = this.claims.list({...filter,statuses:filter.statuses ?? ['accepted','proposed','disputed'],limit:1000});
    const result: Array<{claimIds:[string,string];reason:string}> = [];
    const definitions = new Map(claims.map(c=>[c.predicate,this.relations.get(c.predicate)]));
    for (let i=0;i<claims.length;i++) for (let j=i+1;j<claims.length;j++) {
      const a=claims[i],b=claims[j];
      if (a.subject!==b.subject || a.predicate!==b.predicate || a.context!==b.context || a.namespace!==b.namespace ||
        JSON.stringify(a.qualifiers)!==JSON.stringify(b.qualifiers) || a.unit!==b.unit || a.language!==b.language) continue;
      if (Math.max(a.validFrom ?? -Infinity,b.validFrom ?? -Infinity) >= Math.min(a.validTo ?? Infinity,b.validTo ?? Infinity)) continue;
      const same = a.object===b.object && JSON.stringify(a.value)===JSON.stringify(b.value);
      if (same && a.polarity!==b.polarity) result.push({claimIds:[a.id,b.id],reason:'Opposite assertions in overlapping scope'});
      else if (!same && a.polarity===1 && b.polarity===1 && definitions.get(a.predicate)?.maxTargets===1)
        result.push({claimIds:[a.id,b.id],reason:'Competing values for a single-valued relationship'});
    }
    const explicit = this.db.query<{source_id:string;target_id:string}, []>("SELECT source_id,target_id FROM graph_claim_links WHERE relation='contradicts' LIMIT 1000").all();
    const included = new Set(claims.map(c=>c.id));
    for (const link of explicit) if (included.has(link.source_id) && included.has(link.target_id))
      result.push({claimIds:[link.source_id,link.target_id],reason:'Explicit contradiction'});
    return {conflicts:result,truncated:claims.length===1000 || explicit.length===1000};
  }
}
