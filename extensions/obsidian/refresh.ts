import { fileURLToPath } from 'node:url';
import { sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import type { ShaleSDK } from '@shale/sdk';
import { discoverVaults } from './vault-finder';
import { ingestFile, ingestImageFile } from './ingest-file';
import { parseDocumentFile } from './parse-document';
import { commitDocument } from './commit-document';
import { withSourceRefresh } from '../../lib/memory/refresh-scope';

export function setup(sdk:ShaleSDK) {
  sdk.messages.handle('source:refresh',async request=>{
    const source=sdk.context.getSource(request.sourceId);
    if(!source || source.origin!=='obsidian') return {sourceId:request.sourceId,status:'unavailable',reason:'Source is not owned by Obsidian'};
    return withSourceRefresh({sourceId:source.id,uri:source.uri,topic:request.topic},async()=>{try {
      const path=fileURLToPath(source.uri), canonicalPath=await realpath(path);
      const vaults=await Promise.all(discoverVaults(undefined,sdk).map(async vault=>({...vault,path:await realpath(vault.path)})));
      const vault=vaults.find(v=>canonicalPath.startsWith(v.path.endsWith(sep)?v.path:v.path+sep));
      if(!vault) return {sourceId:source.id,status:'unavailable',reason:'The original vault is no longer configured'};
      const namespace=sdk.settings.get<string>('namespace') ?? sdk.namespace;
      if(source.type==='markdown_note') await ingestFile(path,vault.name,sdk,{vaultPath:vault.path,namespace});
      else if(source.type==='image') await ingestImageFile(path,vault.name,sdk,{vaultPath:vault.path,namespace});
      else commitDocument(sdk,await parseDocumentFile(path,sdk,namespace),vault,namespace);
      return {sourceId:source.id,status:'refreshed',memoryVersion:sdk.memory.get(source.id).version};
    } catch(error) {return {sourceId:source.id,status:'unavailable',reason:String(error).slice(0,300)};}});
  });
}
