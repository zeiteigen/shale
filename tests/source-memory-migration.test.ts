import { expect, test } from 'bun:test';
import { createTestDatabase } from './fixtures/database';
import { createExtensionSDK } from '../sdk';
import { migrateSourceMemory } from '../lib/memory/migrate';

test('offline migration retains exact quoted spans, reports citation gaps, and compacts orphan bodies',()=>{
  const db=createTestDatabase(),sdk=createExtensionSDK('migration',{database:db});
  db.run('DROP TRIGGER memory_chunk_insert_budget; DROP TRIGGER memory_chunk_update_budget');
  const legacy=(id:string,text:string,type='note',uri=`test://${id}`)=>{
    db.query('INSERT INTO sources VALUES(?,?,?,?,?,?,?,?)').run(id,type,uri,'test',1,id,1,`${id}:original`);
    db.query("INSERT INTO chunks(source_id,chunk_index,chunk_type,text_content) VALUES(?,0,'verbatim',?)").run(id,text);
  };
  const text='Unselected background. '.repeat(1000)+'💫 An exact polar-coordinate quotation. '+'More background. '.repeat(1000);
  legacy('note',text);
  const entity=sdk.graph.entities.create({name:'Polar coordinates',type:'Concept'});
  const quote='💫 An exact polar-coordinate quotation.';
  const supported=sdk.graph.claims.add({subject:entity.id,predicate:'DESCRIPTION',value:'quoted',status:'accepted',
    evidence:[{sourceId:'note',chunkIndex:0,quote,locator:{start:text.indexOf(quote),end:text.indexOf(quote)+quote.length}}]});
  legacy('large-quote','x'.repeat(4000));
  const unavailable=sdk.graph.claims.add({subject:entity.id,predicate:'DESCRIPTION',value:'broad',status:'accepted',
    evidence:[{sourceId:'large-quote',chunkIndex:0,quote:'x'.repeat(1400)}]});
  const url='https://example.com/coords';legacy('web','A precise old page.','web_page',url);
  legacy('version','A precise old page.','web_page_version',`browser-content-version://${encodeURIComponent(url)}/capture`);
  const versionClaim=sdk.graph.claims.add({subject:entity.id,predicate:'DESCRIPTION',value:'versioned',status:'accepted',
    evidence:[{sourceId:'version',chunkIndex:0,quote:'precise old page'}]});
  legacy('session:removed',JSON.stringify({visits:Array.from({length:500},(_,i)=>({url:`https://example.com/${i}`,title:`Page ${i}`}))}),'web_session');
  db.query("DELETE FROM sources WHERE id='session:removed'").run();
  const count=db.query<{n:number},[]>('SELECT count(*) AS n FROM graph_evidence').get()!.n;
  const report=migrateSourceMemory(db);
  expect(report.alreadyMigrated).toBe(false);
  expect(db.query<{n:number},[]>('SELECT count(*) AS n FROM graph_evidence').get()!.n).toBe(count);
  const evidence=sdk.graph.evidence.list(supported.id)[0]!;
  expect(evidence.quote).toBe(quote);expect(evidence.availability).toBe('retained');expect(evidence.stale).toBe(false);
  expect(sdk.graph.evidence.revision(evidence.revisionId).chunks).toContainEqual(expect.objectContaining({text_content:quote}));
  expect(sdk.graph.evidence.list(unavailable.id)[0]).toMatchObject({availability:'discarded',quote:undefined});
  expect(sdk.graph.claims.get(unavailable.id).status).toBe('stale');
  expect(sdk.graph.evidence.list(versionClaim.id)[0]).toMatchObject({sourceId:'web',originalSourceId:'version',sourceHash:'version:original',quote:'precise old page'});
  expect(db.query<{n:number},[]>(`SELECT count(*) AS n FROM graph_revision_passages p JOIN graph_source_revisions r ON r.id=p.revision_id
    WHERE r.source_id='session:removed'`).get()!.n).toBe(0);
  expect(db.query('PRAGMA foreign_key_check').all()).toEqual([]);
  expect(db.query<{integrity_check:string},[]>('PRAGMA integrity_check').get()!.integrity_check).toBe('ok');
  expect(migrateSourceMemory(db).alreadyMigrated).toBe(true);
  db.close();
});

test('failed migration rolls back all content compaction before a retry',()=>{
  const db=createTestDatabase(),sdk=createExtensionSDK('migration',{database:db});
  sdk.ingest.sourceAndChunks({source:{id:'s',title:'Guide',uri:'test://s',origin:'test',type:'note'},chunks:[{text_content:'Original material.'}]});
  const before=JSON.stringify(db.query('SELECT * FROM chunks').all());
  db.run("CREATE TRIGGER fail_memory_migration BEFORE INSERT ON graph_migrations WHEN NEW.name='source-memory-v1' BEGIN SELECT RAISE(ABORT,'injected migration failure'); END");
  expect(()=>migrateSourceMemory(db)).toThrow('injected migration failure');
  expect(JSON.stringify(db.query('SELECT * FROM chunks').all())).toBe(before);
  expect(db.query("SELECT 1 FROM graph_migrations WHERE name='source-memory-v1'").get()).toBeNull();
  db.run('DROP TRIGGER fail_memory_migration');
  expect(migrateSourceMemory(db).alreadyMigrated).toBe(false);
  db.close();
});
