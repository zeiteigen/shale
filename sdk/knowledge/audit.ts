import { randomUUIDv7 } from 'bun';
import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { serializeValue } from '../graph/values';
import type { GraphValue } from '../graph/types';
import { compactAudit } from '../../lib/memory/audit';

export interface ChangeContext {actor:string;reason:string;requestId?:string}
export function fingerprint(value:unknown) {return createHash('sha256').update(serializeValue(JSON.parse(JSON.stringify(value)) as GraphValue)).digest('hex');}

export function replay(db:Database,requestId:string|undefined,signature:string):unknown|undefined {
  if(!requestId) return undefined;
  const row=db.query<{fingerprint:string;result:string},[string]>('SELECT fingerprint,result FROM graph_changes WHERE request_id=?').get(requestId);
  if(!row) return undefined;
  if(row.fingerprint!==signature) throw new Error('Request ID already used for a different change');
  return JSON.parse(row.result);
}

export function saveChange(db:Database,input:unknown,context:ChangeContext,result:unknown,changeId=randomUUIDv7()) {
  db.query('INSERT INTO graph_changes(id,request_id,fingerprint,actor,reason,created_at,operations,result) VALUES(?,?,?,?,?,?,?,?)').run(
    changeId,context.requestId ?? null,fingerprint(input),context.actor,context.reason,Date.now(),JSON.stringify(compactAudit(input)),JSON.stringify(compactAudit(result)));
  return changeId;
}
