import { mkdir, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createExtensionSDK } from '../sdk';
import { getGraphData } from '../visualizer/graph-data';

/** Build display snapshots outside the ingestion host's event loop. */
const parentIndex=process.argv.indexOf('--parent');
const parent=Number(process.argv[parentIndex+1]);
if(parentIndex<0 || !Number.isInteger(parent) || parent<=1)throw new Error('A live parent PID is required');
const parentPath=`/proc/${parent}/stat`;
const parentIdentity=(stat:string)=>stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];
const identity=parentIdentity(await readFile(parentPath,'utf8'));
const originIndex=process.argv.indexOf('--origin');
const origin=new URL(process.argv[originIndex+1]);
if(originIndex<0 || !['127.0.0.1','localhost'].includes(origin.hostname))throw new Error('A local host origin is required');
const host=await fetch(new URL('/api/host',origin)).then(response=>response.json()) as {uptime:number};
if(!Number.isFinite(host.uptime))throw new Error('Unable to identify the host instance');
const hostStartedAt=Date.now()-host.uptime*1000;
const sdk=createExtensionSDK('graph-snapshot');
sdk.database.run('PRAGMA query_only=ON');
const directory=join(import.meta.dir,'../visualizer/dist');
const target=join(directory,`knowledge-map-${origin.port || '80'}.json`);
const temporary=join(directory,`.knowledge-map-${process.pid}.json`);
async function parentAlive(){try{return parentIdentity(await readFile(parentPath,'utf8'))===identity;}catch{return false;}}
try {
  while(await parentAlive()) {
    try {
      const started=performance.now();
      const graph={...getGraphData(sdk),generatedAt:new Date().toISOString(),hostStartedAt};
      await mkdir(directory,{recursive:true});await Bun.write(temporary,JSON.stringify(graph));await rename(temporary,target);
      if(process.env.SHALE_GRAPH_PROFILE==='1')console.log(JSON.stringify({snapshotMs:performance.now()-started,nodes:graph.nodes.length,edges:graph.edges.length}));
    } catch(error){console.error('[graph-snapshot]',error instanceof Error?error.message:String(error));}
    // Check ownership frequently so the worker exits promptly with its host.
    for(let elapsed=0;elapsed<30 && await parentAlive();elapsed++)await new Promise(resolve=>setTimeout(resolve,1000));
  }
} finally {await unlink(temporary).catch(()=>{});sdk.database.close();}
