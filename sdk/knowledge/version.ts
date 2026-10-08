import type { Database } from 'bun:sqlite';

export function recordVersion(db: Database, kind: string, id: string | number): number {
  return db.query<{version:number}, [string,string]>(
    'SELECT version FROM graph_record_versions WHERE kind=? AND record_id=?').get(kind,String(id))?.version ?? 0;
}

export function checkVersion(db: Database, kind: string, id: string | number, expected?: number) {
  if (expected !== undefined && recordVersion(db,kind,id) !== expected)
    throw new Error(`Stale ${kind} ${id}; inspect it again before editing`);
}
