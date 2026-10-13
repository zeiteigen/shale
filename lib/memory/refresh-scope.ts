import { AsyncLocalStorage } from 'node:async_hooks';

/** Only an explicit owner refresh may select new memory from unchanged original content. */
export interface SourceRefreshScope {
  sourceId:string; uri:string; topic?:string;
  /** Owner maintenance may rebuild generated memory while preserving agent edits. */
  mode?: 'refine' | 'rebuild-generated';
}
const refresh = new AsyncLocalStorage<SourceRefreshScope>();

export function withSourceRefresh<T>(request:SourceRefreshScope, work:()=>T):T {
  return refresh.run(request,work);
}

export function sourceRefreshScope() { return refresh.getStore(); }
