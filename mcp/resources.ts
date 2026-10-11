import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShaleSDK } from "../sdk";
import { formatToolResponse } from './types';

function jsonText(value:unknown,maxChars=16_000) {
  return formatToolResponse(value,maxChars).content[0]!.text;
}

export function registerKnowledgeGraphResources(mcp: McpServer, sdk: ShaleSDK) {
  const graph = sdk.graph;
  const changesPage=(uri:URL,offset:number)=>{
    const total=sdk.database.query<{total:number},[]>("SELECT count(*) AS total FROM graph_changes").get()?.total ?? 0;
    const limit=20;
    const changes=sdk.database.query<{id:string;actor:string;reason:string;created_at:number},[number,number]>(
      'SELECT id,actor,reason,created_at FROM graph_changes ORDER BY created_at DESC,id LIMIT ? OFFSET ?').all(limit,offset)
      .map(row=>({...row,reason:row.reason.slice(0,300)}));
    const nextOffset=offset+changes.length<total?offset+changes.length:null;
    return {contents:[{uri:uri.href,mimeType:'application/json',text:jsonText({changes,total,limit,offset,nextOffset,
      nextUri:nextOffset===null?null:`graph://changes/page/${nextOffset}`,detailTemplate:'graph://changes/{id}'})}]};
  };
  mcp.resource('graph-changes','graph://changes',async uri=>changesPage(uri,0));
  mcp.resource('graph-changes-page',new ResourceTemplate('graph://changes/page/{offset}',{list:undefined}),async(uri,{offset})=>{
    const pageOffset=Number(offset);
    if(!Number.isSafeInteger(pageOffset)||pageOffset<0) throw new Error('Invalid change page offset');
    return changesPage(uri,pageOffset);
  });
  mcp.resource('graph-change',new ResourceTemplate('graph://changes/{id}',{list:undefined}),async(uri,{id})=>{
    const change=sdk.knowledge.history(String(id));
    if(!change) throw new Error(`Unknown graph change ${id}`);
    return {contents:[{uri:uri.href,mimeType:'application/json',text:jsonText(change)}]};
  });

  mcp.resource("graph-stats", "graph://stats", async (uri) => {
    const entitiesCount = sdk.database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM entities").get()?.count ?? 0;
    const claimsCount = sdk.database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM graph_claims").get()?.count ?? 0;
    const claimsByStatus = sdk.database.query<{ status: string; count: number }, []>(
      "SELECT status, COUNT(*) AS count FROM graph_claims GROUP BY status").all();
    return {contents:[{uri:uri.href,mimeType:'application/json',text:jsonText({entitiesCount,claimsCount,
      claimsByStatus:Object.fromEntries(claimsByStatus.map(r=>[r.status,r.count]))})}]};
  });

  mcp.resource("graph-relations", "graph://relations", async (uri) => {
    const count=sdk.database.query<{count:number},[]>("SELECT count(*) AS count FROM graph_relations").get()!.count;
    const rows=sdk.database.query<{name:string;definition:string},[]>("SELECT name,definition FROM graph_relations ORDER BY name LIMIT 20").all();
    return {contents:[{uri:uri.href,mimeType:'application/json',text:jsonText({relations:rows.map(r=>JSON.parse(r.definition)),count,truncated:count>rows.length,
      continuationGuidance:'Use list_relations for the complete relation list.'})}]};
  });

  mcp.resource('graph-source-memory',new ResourceTemplate('graph://sources/{id}/memory/{offset}',{list:undefined}),async(uri,{id,offset})=>{
    const sourceId=String(id),start=Math.max(0,Number(offset));
    if(!Number.isSafeInteger(start)) throw new Error('Invalid source memory offset');
    const memory=sdk.memory.get(sourceId),limit=5;
    const snippets=memory.snippets.slice(start,start+limit).map(item=>({id:item.id,versionId:item.versionId,kind:item.kind,
      purpose:item.purpose,locator:{originalChunkIndex:item.locator.originalChunkIndex,start:item.locator.start,end:item.locator.end},textPreview:item.text.slice(0,600)}));
    const nextOffset=start+snippets.length<memory.snippets.length?start+snippets.length:null;
    return {contents:[{uri:uri.href,mimeType:'application/json',text:jsonText({source:{id:memory.source.id,title:memory.source.title,uri:memory.source.uri,type:memory.source.type,origin:memory.source.origin},
      version:memory.version,summary:memory.summary,summaryVersionId:memory.summary.versionId,snippets,offset:start,limit,totalSnippets:memory.snippets.length,nextOffset,
      nextUri:nextOffset===null?null:`graph://sources/${encodeURIComponent(sourceId)}/memory/${nextOffset}`,availability:memory.availability,completeOriginal:false})}]};
  });

  mcp.resource('graph-entity',new ResourceTemplate('graph://entities/{id}',{list:undefined}),async(uri,{id})=>{
    const numId=Number(id);
    if(!Number.isInteger(numId)) throw new Error(`Invalid entity ID in URI: ${id}`);
    const entity=graph.entities.get(numId),claimCount=sdk.database.query<{count:number},[number,number]>(
      'SELECT count(*) AS count FROM graph_claims WHERE subject_id=? OR object_id=?').get(numId,numId)!.count;
    const aliasCount=sdk.database.query<{count:number},[number]>("SELECT count(*) AS count FROM graph_aliases WHERE entity_id=?").get(numId)!.count;
    const mergeCount=sdk.database.query<{count:number},[number,number]>("SELECT count(*) AS count FROM graph_identity_changes WHERE entity_id=? OR canonical_id=?").get(numId,numId)!.count;
    const claims=graph.claims.list({entityId:numId,limit:15}).map(({id,subject,predicate,object,value,status,context})=>{
      const encoded=value===undefined?'null':JSON.stringify(value);
      return {id,subject,predicate,object,value:encoded.length<=400?value:{preview:encoded.slice(0,380),truncated:true},status,context};
    });
    const aliases=sdk.database.query<{alias:string;scope:string},[number]>("SELECT alias,scope FROM graph_aliases WHERE entity_id=? ORDER BY scope,alias LIMIT 20").all(numId);
    const merges=sdk.database.query<{id:string;entity_id:number;canonical_id:number;reason:string;created_at:number;undone_at:number|null},[number,number]>(
      'SELECT * FROM graph_identity_changes WHERE entity_id=? OR canonical_id=? ORDER BY created_at DESC LIMIT 10').all(numId,numId)
      .map(row=>({...row,reason:row.reason.slice(0,300)}));
    const data={entity,aliases,aliasCount,merges,mergeCount,claims,claimCount,
      truncated:{aliases:aliasCount>aliases.length,merges:mergeCount>merges.length,claims:claimCount>claims.length},
      continuationGuidance:'Use inspect_entity for identity details and list_claims with entityId and offset 15 for the next claim page.'};
    return {contents:[{uri:uri.href,mimeType:'application/json',text:jsonText(data)}]};
  });

  mcp.resource('graph-claim',new ResourceTemplate('graph://claims/{id}',{list:undefined}),async(uri,{id})=>{
    const claimId=String(id),full=graph.claims.get(claimId),encoded=full.value===undefined?'null':JSON.stringify(full.value);
    const claim={id:full.id,namespace:full.namespace,subject:full.subject,predicate:full.predicate,object:full.object,
      value:encoded.length<=800?full.value:{preview:encoded.slice(0,760),truncated:true},status:full.status,context:full.context,
      confidence:full.confidence,validFrom:full.validFrom,validTo:full.validTo};
    const counts={
      evidence:sdk.database.query<{count:number},[string]>('SELECT count(*) AS count FROM graph_evidence WHERE claim_id=?').get(claimId)!.count,
      reviews:sdk.database.query<{count:number},[string]>('SELECT count(*) AS count FROM graph_reviews WHERE claim_id=?').get(claimId)!.count,
      statusHistory:sdk.database.query<{count:number},[string]>('SELECT count(*) AS count FROM graph_status_history WHERE claim_id=?').get(claimId)!.count,
      links:sdk.database.query<{count:number},[string,string]>('SELECT count(*) AS count FROM graph_claim_links WHERE source_id=? OR target_id=?').get(claimId,claimId)!.count,
    };
    return {contents:[{uri:uri.href,mimeType:'application/json',text:jsonText({claim,counts,
      continuationGuidance:'Use inspect_claim for the audit trail and get_claim_evidence for source citations.'})}]};
  });
}
