import type { Database } from 'bun:sqlite';

/** Rebuild only affected legacy edges, retaining independently justified connections. */
export function projectConnections(db:Database,claimIds:string[]) {
  const pairs=new Map<string,{subject_id:number;object_id:number;predicate:string}>();
  for(const id of claimIds) {
    const row=db.query<{subject_id:number;object_id:number|null;predicate:string},[string]>(
      'SELECT subject_id,object_id,predicate FROM graph_claims WHERE id=?').get(id);
    if(row?.object_id!==null && row?.object_id!==undefined) pairs.set(JSON.stringify(row),{...row,object_id:row.object_id});
  }
  for(const {subject_id,object_id,predicate} of pairs.values()) {
    const live=db.query<{strength:number;qualifiers:string},[number,number,string]>(`SELECT strength,qualifiers FROM graph_claims
      WHERE subject_id=? AND object_id=? AND predicate=? AND polarity=1 AND status IN ('accepted','proposed','disputed')
      ORDER BY CASE status WHEN 'accepted' THEN 0 WHEN 'proposed' THEN 1 ELSE 2 END,strength DESC,id LIMIT 1`).get(subject_id,object_id,predicate);
    db.query('DELETE FROM edges WHERE source_entity_id=? AND target_entity_id=? AND relation=?').run(subject_id,object_id,predicate);
    if(live) {
      const hasMetadata=db.query<{name:string},[]>('PRAGMA table_info(edges)').all().some(c=>c.name==='metadata');
      if(hasMetadata) db.query('INSERT INTO edges(source_entity_id,target_entity_id,relation,weight,metadata) VALUES(?,?,?,?,?)').run(subject_id,object_id,predicate,live.strength,live.qualifiers);
      else db.query('INSERT INTO edges(source_entity_id,target_entity_id,relation,weight) VALUES(?,?,?,?)').run(subject_id,object_id,predicate,live.strength);
    }
  }
}
