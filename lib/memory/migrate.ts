import type { Database } from 'bun:sqlite';
import { ensureGraphSchema } from '../graph/schema';
import { installRevisionTracking } from '../graph/source-revisions';
import { prepareSourceMemory } from './prepare';
import { compactAudit } from './audit';
import { migrateHistoricalEvidence } from './migrate-evidence';
import { memoryHash, recordMemory } from '../../sdk/memory/records';
import { projectMemory } from '../../sdk/memory/projection';
import { compactMemoryHistory } from '../../sdk/memory/retention';
import type { SourceObservationMetadata } from './types';

type Source={id:string;type:string;uri:string;origin:string;title:string;hash:string;created_at:number;updated_at:number};
export function memoryStorageStats(db:Database) {
  const scalar=(sql:string)=>db.query<{n:number},[]>(sql).get()!.n;
  const historical=db.query("SELECT 1 FROM sqlite_master WHERE name='graph_memory_texts'").get()
    ? scalar('SELECT coalesce(sum(length(text_content)),0) AS n FROM graph_memory_texts')
    : scalar('SELECT coalesce(sum(length(text_content)),0) AS n FROM graph_revision_chunks');
  return {sources:scalar('SELECT count(*) AS n FROM sources'),currentCharacters:scalar('SELECT coalesce(sum(length(text_content)),0) AS n FROM chunks'),
    historicalCharacters:historical,evidence:scalar('SELECT count(*) AS n FROM graph_evidence'),
    claims:scalar('SELECT count(*) AS n FROM graph_claims'),pageBytes:scalar('SELECT page_count*page_size AS n FROM pragma_page_count,pragma_page_size')};
}

/** Offline, transactional cutover. Call on a copy first; no ingestion process may write during migration. */
export function migrateSourceMemory(db:Database) {
  const before=memoryStorageStats(db);
  ensureGraphSchema(db);
  if(db.query("SELECT 1 FROM graph_migrations WHERE name='source-memory-v1'").get()) return {alreadyMigrated:true,before,after:before};
  const report=db.transaction(()=>{
    const sources=db.query<Source,[]>('SELECT * FROM sources ORDER BY updated_at,id').all();
    const isVersion=(s:Source)=>['web_page_version','public_web_page_version'].includes(s.type);
    sources.sort((a,b)=>Number(isVersion(b))-Number(isVersion(a)));
    // Compaction changes memory representation, not original-source truth.
    db.run('DROP TRIGGER IF EXISTS graph_source_update');
    let regroundedEvidence=0,discardedEvidence=0,removedVersionSources=0;
    // Ownership is explicit and survives replacing the current search projection.
    db.run(`INSERT OR IGNORE INTO source_entities(source_id,entity_id)
      SELECT s.id,a.entity_id FROM sources s JOIN graph_aliases a ON a.scope='source-id' AND a.alias=s.id;`);
    for(const source of sources) {
      const chunks=db.query<{text_content:string;chunk_type:'verbatim'|'synthetic';chunk_index:number},[string]>(
        'SELECT text_content,chunk_type,chunk_index FROM chunks WHERE source_id=? ORDER BY chunk_index').all(source.id);
      db.query(`INSERT INTO source_revision_fingerprints(revision_id,fingerprint)
        SELECT id,hash FROM graph_source_revisions WHERE source_id=? AND true ON CONFLICT(revision_id) DO NOTHING`).run(source.id);
      if(['web_page_version','public_web_page_version'].includes(source.type)) {
        let url:string|undefined;
        try { url=decodeURIComponent(source.uri.replace(/^browser-content-version:\/\//,'').split('/')[0]!); } catch {}
        const canonical=url?db.query<{id:string},[string,string]>("SELECT id FROM sources WHERE uri IN (?,?) AND type IN ('web_page','public_web_page') ORDER BY type='web_page' DESC LIMIT 1")
          .get(url,`browser-public://${encodeURIComponent(url)}`):null;
        if(canonical) {
          db.query(`UPDATE graph_source_revisions SET original_source_id=coalesce(original_source_id,source_id),original_hash=coalesce(original_hash,hash),
            source_id=?,hash=hash||':legacy-version:'||? WHERE source_id=?`).run(canonical.id,source.id,source.id);
          db.query('INSERT OR IGNORE INTO source_entities SELECT ?,entity_id FROM source_entities WHERE source_id=?').run(canonical.id,source.id);
          if(db.query("SELECT 1 FROM sqlite_master WHERE name='browser_content_cache'").get()) {
            // Only the receipt for the canonical original fingerprint may be reused.
            db.query(`DELETE FROM browser_content_cache WHERE source_id=? AND coalesce(json_extract(prepared,'$.indexedHash'),'')<>
              (SELECT hash FROM sources WHERE id=?)`).run(source.id,canonical.id);
            db.query('UPDATE browser_content_cache SET source_id=? WHERE source_id=?').run(canonical.id,source.id);
          }
          if(db.query("SELECT 1 FROM sqlite_master WHERE name='browser_captures'").get())
            db.query('UPDATE browser_captures SET source_id=? WHERE source_id=?').run(canonical.id,source.id);
        }
        else {
          const evidence=migrateHistoricalEvidence(db,source.id);
          regroundedEvidence+=evidence.regroundedEvidence;discardedEvidence+=evidence.discardedEvidence;
        }
        db.query('DELETE FROM sources WHERE id=?').run(source.id);removedVersionSources++;continue;
      }
      const evidence=migrateHistoricalEvidence(db,source.id);
      regroundedEvidence+=evidence.regroundedEvidence;discardedEvidence+=evidence.discardedEvidence;
      if(db.query('SELECT 1 FROM source_memories WHERE source_id=?').get(source.id)) {
        compactMemoryHistory(db,source.id);continue;
      }
      // Catalog/activity metadata belongs in structured tables, not a raw JSON memory body.
      const memory=prepareSourceMemory(chunks,{title:source.title,
        structuredObservations:['browser_activity','browser_history','browser_bookmark','web_session'].includes(source.type)});
      // Use a new memory revision, keeping old revision IDs and citations explicitly historical.
      db.query('UPDATE sources SET hash=?,updated_at=? WHERE id=?').run(memoryHash(memory,source.hash),source.updated_at,source.id);
      db.query(`INSERT INTO graph_source_revisions(source_id,hash,uri,title,captured_at)
        SELECT id,hash,uri,title,updated_at FROM sources WHERE id=? ON CONFLICT(source_id,hash) DO NOTHING`).run(source.id);
      projectMemory(db,source.id,memory);
      const capture=db.query("SELECT 1 FROM sqlite_master WHERE name='browser_content_cache'").get()
        ? db.query<{quality:SourceObservationMetadata['quality'];captureOrigin:SourceObservationMetadata['captureOrigin']},[string,string]>(
          `SELECT coalesce(json_extract(prepared,'$.extraction.quality'),json_extract(prepared,'$.parser.extraction.quality')) AS quality,
            coalesce(json_extract(prepared,'$.pageData.captureOrigin'),'live-dom') AS captureOrigin
            FROM browser_content_cache WHERE source_id=? AND json_extract(prepared,'$.indexedHash')=? ORDER BY updated_at DESC LIMIT 1`).get(source.id,source.hash)
        : null;
      recordMemory(db,source.id,source.hash,memory,true,capture ?? {});
      compactMemoryHistory(db,source.id);
      db.query('INSERT OR IGNORE INTO chunk_entities(chunk_id,entity_id) SELECT c.id,e.entity_id FROM chunks c JOIN source_entities e ON e.source_id=c.source_id WHERE c.source_id=?').run(source.id);
    }
    for(const archive of db.query<{source_id:string;snapshot:string},[]>('SELECT source_id,snapshot FROM graph_source_archives').all()) {
      const evidence=migrateHistoricalEvidence(db,archive.source_id);
      regroundedEvidence+=evidence.regroundedEvidence;discardedEvidence+=evidence.discardedEvidence;
      const snapshot=JSON.parse(archive.snapshot),memory=prepareSourceMemory(snapshot.chunks??[],{title:snapshot.source.title});
      snapshot.chunks=[{id:0,source_id:archive.source_id,chunk_index:0,chunk_type:'synthetic',text_content:memory.summary},
        ...memory.snippets.map((s,i)=>({id:i+1,source_id:archive.source_id,chunk_index:i+1,chunk_type:s.kind==='excerpt'?'verbatim':'synthetic',text_content:s.text}))];
      snapshot.links=[];
      snapshot.memory=memory;snapshot.fingerprint=snapshot.fingerprint??snapshot.source.hash;
      db.query('UPDATE graph_source_archives SET snapshot=? WHERE source_id=?').run(JSON.stringify(snapshot),archive.source_id);
    }
    for(const orphan of db.query<{source_id:string},[]>(`SELECT DISTINCT source_id FROM graph_source_revisions r
      WHERE NOT EXISTS(SELECT 1 FROM sources s WHERE s.id=r.source_id)
      AND NOT EXISTS(SELECT 1 FROM graph_source_archives a WHERE a.source_id=r.source_id)`).all()) {
      const evidence=migrateHistoricalEvidence(db,orphan.source_id);
      regroundedEvidence+=evidence.regroundedEvidence;discardedEvidence+=evidence.discardedEvidence;
    }
    for(const change of db.query<{id:string;operations:string;result:string},[]>('SELECT id,operations,result FROM graph_changes').all())
      db.query('UPDATE graph_changes SET operations=?,result=? WHERE id=?').run(JSON.stringify(compactAudit(JSON.parse(change.operations))),JSON.stringify(compactAudit(JSON.parse(change.result))),change.id);
    const exists=(table:string)=>!!db.query('SELECT 1 FROM sqlite_master WHERE name=?').get(table);
    if(exists('browser_content_cache')) {
      db.run(`DELETE FROM browser_content_cache WHERE source_id NOT IN (SELECT id FROM sources);
        UPDATE browser_content_cache SET prepared=json_object('cacheState','complete','canonicalSourceId',source_id,
          'sourceFingerprint',(SELECT fingerprint FROM source_memories m WHERE m.source_id=browser_content_cache.source_id),
          'indexedHash',(SELECT hash FROM sources s WHERE s.id=browser_content_cache.source_id),
          'captureOrigin',coalesce(json_extract(prepared,'$.pageData.captureOrigin'),'live-dom'),
          'extraction',json(coalesce(json_extract(prepared,'$.extraction'),json_extract(prepared,'$.parser.extraction'),'{}')),
          'graphMetadata',json_object('topics',json('[]'),'category','general'));`);
    }
    if(exists('browser_jobs')) db.run(`UPDATE browser_jobs SET prepared=NULL,settings=NULL,
      payload=json_object('type',json_extract(payload,'$.type'),'recordId',record_id,'collectorId',collector_id,'url',json_extract(payload,'$.url')),payload_bytes=0,
      state=CASE WHEN state IN ('received','prepared') THEN 'failed' ELSE state END,
      error=CASE WHEN state IN ('received','prepared') THEN 'Pre-upgrade capture discarded; resubmit' ELSE error END;`);
    if(exists('browser_sessions')) db.run('UPDATE browser_sessions SET prepared=NULL,settings=NULL');
    // Pre-upgrade preparations reference discarded bodies. Rescan from the last committed watermark.
    db.run('DELETE FROM checkpoints');
    if(exists('source_link_work')) db.run('DELETE FROM source_link_work; DELETE FROM source_link_batch');
    db.run(`DELETE FROM extension_state WHERE state_key LIKE 'extraction-cursor:%' OR state_key LIKE 'extraction-rejected:%';
      UPDATE graph_claims SET status='retracted' WHERE predicate IN ('CHUNK_LOCATION','HAS_CONTENT') AND status NOT IN ('retracted','rejected','superseded');
      DELETE FROM graph_memory_texts WHERE NOT EXISTS(SELECT 1 FROM graph_revision_passages p WHERE p.text_id=graph_memory_texts.id);
      INSERT INTO graph_migrations VALUES('source-memory-v1');`);
    installRevisionTracking(db);
    const foreignKeys=db.query('PRAGMA foreign_key_check').all();
    if(foreignKeys.length) throw new Error(`Migration foreign-key failures: ${foreignKeys.length}`);
    return {regroundedEvidence,discardedEvidence,removedVersionSources};
  })();
  return {alreadyMigrated:false,before,after:memoryStorageStats(db),...report};
}
