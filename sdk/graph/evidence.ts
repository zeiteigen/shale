import { randomUUIDv7 } from "bun";
import type { Database } from "bun:sqlite";
import type { Evidence, EvidenceInput } from "./types";

export class GraphEvidence {
  constructor(private db: Database) {}

  add(claimId: string, input: EvidenceInput): string {
    return this.db.transaction(()=>this.insert(claimId,input))();
  }

  private insert(claimId: string, input: EvidenceInput): string {
    if (!this.db.query('SELECT 1 FROM graph_claims WHERE id=?').get(claimId)) throw new Error('Unknown claim');
    const revision = input.revisionId === undefined
      ? this.db.query<{id:number;source_id:string}, [string]>(`SELECT r.id,r.source_id FROM graph_source_revisions r
          JOIN sources s ON s.id=r.source_id AND s.hash=r.hash WHERE s.id=?`).get(input.sourceId ?? '')
      : this.db.query<{id:number;source_id:string}, [number]>('SELECT id,source_id FROM graph_source_revisions WHERE id=?').get(input.revisionId);
    if (!revision || (input.sourceId && input.sourceId !== revision.source_id)) throw new Error('Unknown or mismatched source revision');
    if (input.confidence !== undefined && (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1))
      throw new Error('Evidence confidence must be between 0 and 1');
    const locator = input.locator ?? {};
    for (const key of ['start','end','page','timestampMs'] as const) {
      if (locator[key] !== undefined && (!Number.isInteger(locator[key]) || locator[key]! < 0)) throw new Error('Invalid evidence locator');
    }
    if (locator.region && (locator.region.length !== 4 || locator.region.some(n => !Number.isFinite(n))))
      throw new Error('Region must contain four finite coordinates');
    if (input.chunkIndex !== undefined) {
      const chunk = this.db.query<{text_content:string}, [number,number]>(
        'SELECT text_content FROM graph_revision_chunks WHERE revision_id=? AND chunk_index=?').get(revision.id,input.chunkIndex);
      if (!chunk) throw new Error('Unknown revision chunk');
      if ((locator.start === undefined) !== (locator.end === undefined)) throw new Error('Both span boundaries are required');
      if (locator.start !== undefined && locator.end !== undefined) {
        if (locator.start >= locator.end || locator.end > chunk.text_content.length) throw new Error('Invalid evidence span');
        if (input.quote !== undefined && chunk.text_content.slice(locator.start,locator.end) !== input.quote)
          throw new Error('Evidence quote does not match span');
      } else if (input.quote !== undefined && !chunk.text_content.includes(input.quote)) throw new Error('Evidence quote is absent from chunk');
    } else if (input.quote !== undefined || locator.start !== undefined || locator.end !== undefined) {
      throw new Error('Text evidence requires a chunk index');
    }
    const id = input.id ?? randomUUIDv7();
    this.db.query(`INSERT INTO graph_evidence
      (id,claim_id,revision_id,chunk_index,stance,locator,quote,method,model,confidence,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id,claimId,revision.id,input.chunkIndex ?? null,input.stance ?? 'supports',
        JSON.stringify(locator),input.quote ?? null,input.method ?? 'manual',input.model ?? null,input.confidence ?? null,Date.now());
    if ((input.stance ?? 'supports') === 'supports' && !this.db.query(`SELECT 1 FROM sources s
        JOIN graph_source_revisions r ON r.source_id=s.id AND r.hash=s.hash WHERE r.id=?`).get(revision.id))
      this.db.query("UPDATE graph_claims SET status='stale' WHERE id=? AND status IN ('accepted','proposed','disputed')").run(claimId);
    if (input.chunkIndex !== undefined && this.db.query("SELECT 1 FROM sqlite_master WHERE name='chunk_entities'").get()) {
      this.db.query(`INSERT OR IGNORE INTO chunk_entities(chunk_id,entity_id)
        SELECT c.id,n.id FROM chunks c JOIN sources s ON s.id=c.source_id
        JOIN graph_source_revisions r ON r.source_id=s.id AND r.hash=s.hash
        JOIN graph_claims claim ON claim.id=? JOIN entities n ON n.id=claim.subject_id OR n.id=claim.object_id
        WHERE r.id=? AND c.chunk_index=?`).run(claimId,revision.id,input.chunkIndex);
    }
    return id;
  }

  list(claimId: string): Evidence[] {
    if (!this.db.query("SELECT 1 FROM sqlite_master WHERE name='sources'").get()) return [];
    const historyExists = this.db.query("SELECT 1 FROM sqlite_master WHERE name='graph_evidence_history'").get();
    const rows = this.db.query<Record<string,unknown>, [string]>(`SELECT e.*,r.source_id,r.hash,r.uri,r.title,
      ${historyExists ? '(SELECT withdrawn_at FROM graph_evidence_history h WHERE h.evidence_id=e.id)' : 'NULL'} AS withdrawn_at,
      ${historyExists ? '(SELECT replacement_id FROM graph_evidence_history h WHERE h.evidence_id=e.id)' : 'NULL'} AS replacement_id,
      NOT EXISTS(SELECT 1 FROM sources s WHERE s.id=r.source_id AND s.hash=r.hash) AS stale
      FROM graph_evidence e JOIN graph_source_revisions r ON r.id=e.revision_id WHERE e.claim_id=? ORDER BY e.created_at,e.id`).all(claimId);
    return rows.map(r => ({id:r.id as string,claimId,revisionId:r.revision_id as number,
      sourceId:r.source_id as string,sourceHash:r.hash as string,uri:r.uri as string,title:r.title as string,
      chunkIndex:r.chunk_index as number ?? undefined,stance:r.stance as Evidence['stance'],locator:JSON.parse(r.locator as string),
      quote:r.quote as string ?? undefined,method:r.method as string,model:r.model as string ?? undefined,
      confidence:r.confidence as number ?? undefined,createdAt:r.created_at as number,stale:Boolean(r.stale),
      withdrawnAt:r.withdrawn_at as number ?? undefined,replacementId:r.replacement_id as string ?? undefined}));
  }

  revision(revisionId: number) {
    const revision = this.db.query('SELECT * FROM graph_source_revisions WHERE id=?').get(revisionId);
    if (!revision) throw new Error('Unknown source revision');
    return {revision,chunks:this.db.query('SELECT * FROM graph_revision_chunks WHERE revision_id=? ORDER BY chunk_index').all(revisionId)};
  }
}
