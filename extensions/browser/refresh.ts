import type { ShaleSDK } from '@shale/sdk';
import type { SourceRefreshRequest, SourceRefreshResponse } from '../../lib/messages/memory-contracts';
import type { BrowserExtensionSettings } from './settings.types';
import { preparePublicCapture } from './public-capture';
import { finalizePageVisit } from './page-ingest';
import { withSourceRefresh } from '../../lib/memory/refresh-scope';

export async function refreshBrowserSource(sdk:ShaleSDK,request:SourceRefreshRequest):Promise<SourceRefreshResponse> {
  const source=sdk.context.getSource(request.sourceId);
  if(!source || source.origin!=='browser' || source.type!=='web_page') return {sourceId:request.sourceId,status:'unavailable',reason:'This source has no reaccessible page body'};
  const settings=sdk.settings.getAll<BrowserExtensionSettings>();
  if(!settings.allowPublicPageEnrichment) return {sourceId:source.id,status:'unavailable',reason:'Recapture the authenticated browser tab, or enable public page enrichment'};
  return withSourceRefresh({sourceId:source.id,uri:source.uri,topic:request.topic},async()=>{try {
    const before=sdk.memory.get(source.id);
    const prepared=await preparePublicCapture(sdk,{type:'public_page_capture',url:source.uri,title:source.title},settings);
    if(!prepared) return {sourceId:source.id,status:'unavailable',reason:'Page blocked by capture policy'};
    await finalizePageVisit(sdk,prepared,settings);
    const after=sdk.memory.get(source.id);
    return after.version===before.version ? {sourceId:source.id,status:'unavailable',reason:'The fetch added no new retained memory; recapture the live tab for authenticated content'}
      : {sourceId:source.id,status:'refreshed',memoryVersion:after.version};
  } catch(error) {return {sourceId:source.id,status:'unavailable',reason:String(error).slice(0,300)};}});
}
