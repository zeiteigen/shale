import { createHash } from "node:crypto";
import type { Database } from 'bun:sqlite';
import type { GraphClaims } from "./claims";
import type { GraphRelations } from "./relations";

/** Explicit opt-in rules only. Similarity and causality are never inferred from paths. */
export class GraphInference {
  constructor(private db: Database, private claims: GraphClaims, private relations: GraphRelations) {}
  transitive(predicate: string, namespace: string, context = '', limit = 100) {
    return this.db.transaction(()=>this.derive(predicate,namespace,context,limit))();
  }
  private derive(predicate: string, namespace: string, context: string, limit: number) {
    if (!this.relations.get(predicate)?.transitive) throw new Error('Relationship is not declared transitive');
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid inference budget');
    const parents = this.claims.list({predicate,namespace,context,statuses:['accepted'],polarity:1,limit:1000});
    const created: string[] = [];
    let examined=0;
    const bySubject = new Map<number,typeof parents>();
    for (const parent of parents) bySubject.set(parent.subject,[...(bySubject.get(parent.subject) ?? []),parent]);
    for (const a of parents) for (const b of bySubject.get(a.object ?? -1) ?? []) {
      if (++examined>limit*20) return {claimIds:created,truncated:true};
      if (b.object === undefined || a.subject === b.object) continue;
      if (JSON.stringify(a.qualifiers)!==JSON.stringify(b.qualifiers)) continue;
      const from = Math.max(a.validFrom ?? -Infinity,b.validFrom ?? -Infinity);
      const to = Math.min(a.validTo ?? Infinity,b.validTo ?? Infinity);
      if (from >= to) continue;
      const id = `inferred:${createHash('sha256').update(JSON.stringify([a.id,b.id])).digest('hex')}`;
      try { this.claims.get(id); continue; } catch {}
      this.claims.add({id,subject:a.subject,predicate,object:b.object,namespace,context,status:'accepted',
        validFrom:Number.isFinite(from) ? from : undefined,validTo:Number.isFinite(to) ? to : undefined,
        qualifiers:a.qualifiers,method:'rule:transitive',dependsOn:[a.id,b.id]});
      created.push(id);
      if (created.length >= limit) return {claimIds:created,truncated:true};
    }
    return {claimIds:created,truncated:parents.length === 1000};
  }
}
