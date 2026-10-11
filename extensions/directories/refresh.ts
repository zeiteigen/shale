import { fileURLToPath } from 'node:url';
import { sep } from 'node:path';
import { realpath } from 'node:fs/promises';
import type { ShaleSDK } from '@shale/sdk';
import type { DirectoryResult } from './types';
import type { DirectorySettings } from './settings.types';
import { resolveDirectory } from './scan';
import { prepareDirectoryFile } from './prepare-file';
import { commitFile } from './commit';
import { withSourceRefresh } from '../../lib/memory/refresh-scope';

export function setup(sdk:ShaleSDK) {
  sdk.messages.handle('source:refresh',async request=>{
    const source=sdk.context.getSource(request.sourceId);
    if(!source || source.origin!=='directories') return {sourceId:request.sourceId,status:'unavailable',reason:'Source is not owned by directories'};
    return withSourceRefresh({sourceId:source.id,uri:source.uri,topic:request.topic},async()=>{try {
      const path=fileURLToPath(source.uri),canonicalPath=await realpath(path),settings=sdk.settings.getAll<DirectorySettings>();
      const roots=await Promise.all((settings.directories??[]).map(resolveDirectory));
      const directory=roots.find(root=>canonicalPath.startsWith(root.path.endsWith(sep)?root.path:root.path+sep));
      if(!directory) return {sourceId:source.id,status:'unavailable',reason:'The original directory is no longer configured'};
      const result:DirectoryResult={directory:directory.path,filesProcessed:0,filesSkipped:0,chunksCreated:0,errors:[]};
      const prepared=await prepareDirectoryFile(sdk,settings,true,sdk.namespace,directory,result,path);
      if(!prepared) return {sourceId:source.id,status:'unavailable',reason:result.errors[0]?.error ?? 'Processor unavailable'};
      commitFile(sdk,prepared.id,prepared.data);
      return {sourceId:source.id,status:'refreshed',memoryVersion:sdk.memory.get(source.id).version};
    } catch(error) {return {sourceId:source.id,status:'unavailable',reason:String(error).slice(0,300)};}});
  });
}
