export interface SourceRefreshRequest {sourceId:string;actor:string;reason:string;topic?:string}
export interface SourceRefreshResponse {sourceId:string;status:'refreshed'|'unavailable';memoryVersion?:number;reason?:string}
export interface MemoryChannelDefinitions {
  'source:refresh': { type:'request'; request:SourceRefreshRequest; response:SourceRefreshResponse };
}
