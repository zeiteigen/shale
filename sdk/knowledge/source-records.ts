import type { Database } from 'bun:sqlite';
import type { PreparedSourceMemory } from '../../lib/memory/types';

export type Source = {id:string;type:string;uri:string;origin:string;created_at:number;title:string;updated_at:number;hash:string};
export type Chunk = {id:number;source_id:string;chunk_index:number;chunk_type:string;text_content:string};
export type Snapshot = {source:Source;chunks:Chunk[];links:{chunk_id:number;entity_id:number}[];metadata:Record<string,unknown>;fingerprint?:string;memory?:PreparedSourceMemory};

export class SourceRecords {
  constructor(private db:Database) {}
  source(id:string):Source {
    const row=this.db.query<Source,[string]>('SELECT * FROM sources WHERE id=?').get(id);
    if(!row) throw new Error(`Unknown live source: ${id}`); return row;
  }
  chunks(id:string):Chunk[] { return this.db.query<Chunk,[string]>('SELECT * FROM chunks WHERE source_id=? ORDER BY chunk_index,id').all(id); }
  chunk(sourceId:string,id:number):Chunk {
    this.source(sourceId);
    const row=this.db.query<Chunk,[number,string]>('SELECT * FROM chunks WHERE id=? AND source_id=?').get(id,sourceId);
    if(!row) throw new Error(`Unknown chunk ${id} in source ${sourceId}`); return row;
  }
  archive(id:string):Snapshot {
    const row=this.db.query<{snapshot:string},[string]>('SELECT snapshot FROM graph_source_archives WHERE source_id=?').get(id);
    if(!row) throw new Error(`Unknown removed source: ${id}`); return JSON.parse(row.snapshot) as Snapshot;
  }
  getMetadata(id:string):Record<string,unknown> {
    const row=this.db.query<{metadata:string},[string]>('SELECT metadata FROM graph_source_metadata WHERE source_id=?').get(id);
    return row ? JSON.parse(row.metadata):{};
  }
}
