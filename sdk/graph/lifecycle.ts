import type { Database } from "bun:sqlite";
import type { ClaimStatus } from "./types";
import type { GraphClaims } from "./claims";
import type { GraphRelations } from "./relations";

export class GraphLifecycle {
  constructor(private db: Database, private claims: GraphClaims, private relations: GraphRelations) {}
  review(id: string, status: ClaimStatus, actor: string, reason: string) {
    if (!actor.trim() || !reason.trim()) throw new Error('Review actor and reason are required');
    return this.db.transaction(() => {
      const claim = this.claims.get(id);
      if (status === 'accepted') {
        this.relations.validate({...claim,status});
        const inactive = this.db.query(`SELECT 1 FROM graph_dependencies d JOIN graph_claims p ON p.id=d.depends_on
          WHERE d.claim_id=? AND p.status!='accepted'`).get(id);
        if (inactive) throw new Error('Derived claims require accepted dependencies');
      }
      this.db.query('UPDATE graph_claims SET status=? WHERE id=?').run(status,id);
      this.db.query(`INSERT INTO graph_reviews(claim_id,previous_status,status,actor,reason,reviewed_at) VALUES(?,?,?,?,?,?)`)
        .run(id,claim.status,status,actor,reason,Date.now());
      return this.claims.get(id);
    })();
  }
  link(from: string, to: string, relation: 'supports'|'contradicts'|'supersedes', actor = 'sdk', reason = relation as string) {
    this.db.transaction(() => {
      this.claims.get(from); this.claims.get(to);
      this.db.query('INSERT OR IGNORE INTO graph_claim_links VALUES(?,?,?)').run(from,to,relation);
      if (relation === 'supersedes') this.review(to,'superseded',actor,reason);
    })();
  }
  inspect(id: string) {
    const claim = this.claims.get(id);
    return {claim,
      links:this.db.query('SELECT * FROM graph_claim_links WHERE source_id=? OR target_id=?').all(id,id),
      dependencies:this.db.query<{depends_on:string}, [string]>('SELECT depends_on FROM graph_dependencies WHERE claim_id=?').all(id).map(r=>r.depends_on),
      dependents:this.db.query<{claim_id:string}, [string]>('SELECT claim_id FROM graph_dependencies WHERE depends_on=?').all(id).map(r=>r.claim_id),
      reviews:this.db.query('SELECT * FROM graph_reviews WHERE claim_id=? ORDER BY id').all(id),
      history:this.db.query('SELECT * FROM graph_status_history WHERE claim_id=? ORDER BY id').all(id)};
  }
}
