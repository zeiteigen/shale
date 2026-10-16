import type { ShaleSDK } from "@shale/sdk";
import { registerSearchIndexing } from "./search-index";

export function registerMessages(sdk: ShaleSDK) {
  registerSearchIndexing(sdk);
  sdk.messages.handle('graph:ingest-claims',req=>({claims:sdk.graph.ingestClaims(req.claims)}));
  sdk.messages.handle('graph:query',req=>sdk.graph.query.traverse(req));
  sdk.messages.handle('graph:claims',req=>({claims:sdk.graph.claims.list(req)}));
  sdk.messages.handle('graph:inspect',req=>sdk.graph.inspect(req.claimId));
  sdk.messages.handle('graph:review',req=>sdk.graph.lifecycle.review(req.claimId,req.status,req.actor,req.reason));
  sdk.messages.handle('graph:entity',req=>sdk.graph.entities.create(req));
  sdk.messages.handle('graph:event',req=>sdk.graph.events.create(req));
  sdk.messages.handle('graph:events',req=>({events:sdk.graph.events.list(req)}));
  sdk.messages.handle('graph:resolve',req=>({entities:sdk.graph.entities.resolve(req.name,req.scope,req.namespace)}));
  sdk.messages.handle('graph:merge',req=>({changeId:sdk.graph.entities.merge(req.from,req.into,req.reason)}));
  sdk.messages.handle('graph:unmerge',req=>{sdk.graph.entities.unmerge(req.changeId);return {success:true};});
  sdk.messages.handle('search:graph',req=>sdk.search.graph(req));
  sdk.messages.handle('graph:link-entities',req=> {
    const source=sdk.graph.entities.resolve(req.sourceEntity,'',req.namespace);
    const target=sdk.graph.entities.resolve(req.targetEntity,'',req.namespace);
    if (source.length!==1 || target.length!==1) return {success:false,edgesCreated:0,error:'Unknown or ambiguous entities'};
    const edges = [{source:source[0].id,target:target[0].id,relation:req.relation,weight:req.weight,metadata:req.metadata}];
    const inverse=sdk.graph.relations.reciprocal(req.relation);
    if (req.bidirectional && inverse) edges.push({...edges[0],source:target[0].id,target:source[0].id,relation:inverse});
    return {success:true,edgesCreated:sdk.graph.ingest({entities:[],edges,namespace:req.namespace}).edgesInserted};
  });
}
