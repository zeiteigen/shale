import { Database } from 'bun:sqlite';
import { resolve } from 'node:path';
import { migrateSourceMemory, memoryStorageStats } from '../lib/memory/migrate';

const args=process.argv.slice(2),path=args[args.indexOf('--database')+1];
if(!args.includes('--database') || !path || !args.includes('--apply')) throw new Error('Use --database /path/to/offline.db --apply [--compact] [--report /path/report.json]. Test on a copy first. Stop all writers before applying to production.');
const db=new Database(resolve(path));
db.run('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON');
const report=migrateSourceMemory(db);
if(args.includes('--compact')) db.run("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild'); INSERT INTO chunks_fts(chunks_fts) VALUES('optimize'); PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE)");
report.after=memoryStorageStats(db);
const reportIndex=args.indexOf('--report');
if(reportIndex>=0) await Bun.write(args[reportIndex+1]!,JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
db.close();
