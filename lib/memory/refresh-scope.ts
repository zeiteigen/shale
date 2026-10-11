import { AsyncLocalStorage } from 'node:async_hooks';

/** Only an explicit owner refresh may select new memory from unchanged original content. */
const refresh = new AsyncLocalStorage<{sourceId:string;uri:string;topic?:string}>();

export function withSourceRefresh<T>(request:{sourceId:string;uri:string;topic?:string}, work:()=>T):T {
  return refresh.run(request,work);
}

export function sourceRefreshScope() { return refresh.getStore(); }
