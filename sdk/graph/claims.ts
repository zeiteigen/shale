import { randomUUIDv7 } from "bun";
import type { Database } from "bun:sqlite";
import type { Claim, ClaimFilter, ClaimInput } from "./types";
import type { GraphRelations } from "./relations";
import type { GraphEvidence } from "./evidence";
import { serializeValue, validateValue } from "./values";

export function hydrateClaim(row: Record<string,unknown>): Claim {
  return {id:row.id as string,namespace:row.namespace as string,subject:row.subject_id as number,
    predicate:row.predicate as string,object:row.object_id as number ?? undefined,
    value:row.value_json === null ? undefined : JSON.parse(row.value_json as string),
    datatype:row.datatype as string ?? undefined,unit:row.unit as string ?? undefined,language:row.language as string ?? undefined,
    polarity:row.polarity as 1|-1,context:row.context as string,qualifiers:JSON.parse(row.qualifiers as string),
    validFrom:row.valid_from as number ?? undefined,validTo:row.valid_to as number ?? undefined,
    observedAt:row.observed_at as number,recordedAt:row.recorded_at as number,confidence:row.confidence as number ?? undefined,
    strength:row.strength as number,method:row.method as string,model:row.model as string ?? undefined,
    extractionRun:row.extraction_run as string ?? undefined,status:row.status as Claim['status']};
}

export class GraphClaims {
  constructor(private db: Database, private namespace: string, private relations: GraphRelations, private evidence: GraphEvidence) {}

  add(input: ClaimInput): Claim {
    return this.db.transaction(() => {
      if ((input.object !== undefined) === (input.value !== undefined)) throw new Error('Claim requires exactly one object or value');
      if (input.value !== undefined) validateValue(input.value);
      validateValue(input.qualifiers ?? {});
      if (input.datatype && ['string','number','boolean','object'].includes(input.datatype) && typeof input.value !== input.datatype)
        throw new Error('Claim value does not match datatype');
      for (const time of [input.validFrom,input.validTo,input.observedAt])
        if (time !== undefined && (!Number.isSafeInteger(time))) throw new Error('Claim times must be integer milliseconds');
      if (input.validFrom !== undefined && input.validTo !== undefined && input.validFrom >= input.validTo) throw new Error('Invalid claim validity interval');
      if (input.confidence !== undefined && (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) throw new Error('Confidence must be between 0 and 1');
      if (input.strength !== undefined && !Number.isFinite(input.strength)) throw new Error('Strength must be finite');
      const status = input.status ?? 'proposed';
      this.relations.validate({...input,namespace:input.namespace ?? this.namespace,status});
      const id = input.id ?? randomUUIDv7();
      const existing = this.db.query('SELECT 1 FROM graph_claims WHERE id=?').get(id);
      if (existing) throw new Error(`Claim ${id} already exists; use review or supersede rather than overwriting`);
      const now = Date.now();
      this.db.query(`INSERT INTO graph_claims(id,namespace,subject_id,predicate,object_id,value_json,datatype,unit,language,
        polarity,context,qualifiers,valid_from,valid_to,observed_at,recorded_at,confidence,strength,method,model,extraction_run,status)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,input.namespace ?? this.namespace,input.subject,input.predicate,
          input.object ?? null,input.value === undefined ? null : serializeValue(input.value),input.datatype ?? null,input.unit ?? null,
          input.language ?? null,input.polarity ?? 1,input.context ?? '',serializeValue(input.qualifiers ?? {}),input.validFrom ?? null,
          input.validTo ?? null,input.observedAt ?? now,now,input.confidence ?? null,input.strength ?? 1,input.method ?? 'manual',
          input.model ?? null,input.extractionRun ?? null,status);
      for (const parent of input.dependsOn ?? []) {
        const dependency = this.get(parent);
        if (['rejected','retracted','superseded','stale','disputed'].includes(dependency.status)) throw new Error('Cannot derive from inactive or disputed claims');
        this.db.query('INSERT INTO graph_dependencies VALUES(?,?)').run(id,parent);
      }
      for (const item of input.evidence ?? []) this.evidence.add(id,item);
      return this.get(id);
    })();
  }

  get(id: string): Claim {
    const row = this.db.query<Record<string,unknown>, [string]>('SELECT * FROM graph_claims WHERE id=?').get(id);
    if (!row) throw new Error(`Unknown claim ${id}`);
    return hydrateClaim(row);
  }

  list(filter: ClaimFilter = {}): Claim[] {
    const where: string[] = []; const params: (string|number)[] = [];
    for (const [key,column] of [['subject','subject_id'],['predicate','predicate'],['namespace','namespace'],['context','context'],['polarity','polarity']] as const)
      if (filter[key] !== undefined) { where.push(`${column}=?`); params.push(filter[key]!); }
    if (filter.entityId !== undefined) { where.push('(subject_id=? OR object_id=?)'); params.push(filter.entityId,filter.entityId); }
    if (filter.objectOnly) where.push('object_id IS NOT NULL');
    if (filter.predicates) {
      if (!filter.predicates.length) return [];
      where.push(`predicate IN (${filter.predicates.map(()=>'?').join(',')})`); params.push(...filter.predicates);
    }
    const statusExpression = filter.knownAt === undefined ? 'status' :
      `(SELECT h.status FROM graph_status_history h WHERE h.claim_id=graph_claims.id AND h.changed_at<=${Math.trunc(filter.knownAt)} ORDER BY h.changed_at DESC,h.id DESC LIMIT 1)`;
    if (filter.knownAt !== undefined && !Number.isSafeInteger(filter.knownAt)) throw new Error('Invalid knowledge timestamp');
    if (filter.statuses) {
      if (!filter.statuses.length) return [];
      where.push(`${statusExpression} IN (${filter.statuses.map(()=>'?').join(',')})`); params.push(...filter.statuses);
    }
    if (filter.at !== undefined) { where.push('(valid_from IS NULL OR valid_from<=?) AND (valid_to IS NULL OR valid_to>?)'); params.push(filter.at,filter.at); }
    if (filter.knownAt !== undefined) { where.push('recorded_at<=?'); params.push(filter.knownAt); }
    const limit = Math.max(1,Math.min(1000,Math.trunc(filter.limit ?? 100)));
    const offset = Math.max(0,Math.trunc(filter.offset ?? 0));
    if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(offset) || (filter.at !== undefined && !Number.isSafeInteger(filter.at)))
      throw new Error('Invalid graph query bounds');
    params.push(limit,offset);
    return this.db.query<Record<string,unknown>, (string|number)[]>(`SELECT *,${statusExpression} AS status FROM graph_claims
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY recorded_at,id LIMIT ? OFFSET ?`).all(...params).map(hydrateClaim);
  }
}
