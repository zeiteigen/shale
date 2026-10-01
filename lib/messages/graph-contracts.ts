import type { Claim, ClaimFilter, ClaimInput, ClaimStatus, EntityInput, EventInput, EventRecord, GraphEntity, GraphTraversal, TraversalOptions } from "../../sdk/graph/types";
import type { GraphIngestor } from "../../sdk/graph";
import type { GraphSearchOptions, GraphSearchResult } from "../../sdk/graph/retrieval";

export interface GraphChannelDefinitions {
  'graph:ingest-claims': {type:'request';request:{claims:ClaimInput[]};response:{claims:Claim[]}};
  'graph:query': {type:'request';request:TraversalOptions;response:GraphTraversal};
  'graph:claims': {type:'request';request:ClaimFilter;response:{claims:Claim[]}};
  'graph:inspect': {type:'request';request:{claimId:string};response:ReturnType<GraphIngestor['inspect']>};
  'graph:review': {type:'request';request:{claimId:string;status:ClaimStatus;actor:string;reason:string};response:Claim};
  'graph:entity': {type:'request';request:EntityInput;response:GraphEntity};
  'graph:event': {type:'request';request:EventInput;response:EventRecord};
  'graph:events': {type:'request';request:Parameters<GraphIngestor['events']['list']>[0];response:{events:EventRecord[]}};
  'graph:resolve': {type:'request';request:{name:string;scope?:string;namespace?:string};response:{entities:GraphEntity[]}};
  'graph:merge': {type:'request';request:{from:number;into:number;reason:string};response:{changeId:string}};
  'graph:unmerge': {type:'request';request:{changeId:string};response:{success:boolean}};
  'search:graph': {type:'request';request:GraphSearchOptions;response:GraphSearchResult};
}
