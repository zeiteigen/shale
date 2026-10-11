import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ShaleSDK } from '../../sdk';
import type { SourceRefreshRequest, SourceRefreshResponse } from '../../lib/messages/memory-contracts';
import { formatToolError, formatToolResponse } from '../types';

const locator = z.record(z.string(), z.unknown()).default({});
const snippet = z.object({
  text: z.string().min(1).max(1200),
  kind: z.enum(['excerpt','derived']),
  locator,
  purpose: z.string().min(1),
});

export function registerMemoryTools(mcp: McpServer, sdk: ShaleSDK) {
  mcp.tool('refresh_source', 'Explicitly request the owning extension to refresh retained source memory. Reads never refresh automatically; the owner may report unavailable when the source cannot be safely re-read.', {
    sourceId:z.string().min(1), actor:z.string().trim().min(1), reason:z.string().trim().min(1), topic:z.string().optional(),
  }, {readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}, async args=>{
    try { return formatToolResponse(await refreshSourceMemory(sdk,args)); } catch(err) { return formatToolError(err); }
  });
  mcp.tool('get_source_memory', 'Read the current retained summary and active snippets for a source with offset pagination. Original full source content may have been discarded; this read never refreshes it.', {
    sourceId:z.string(), offset:z.number().int().min(0).default(0), limit:z.number().int().min(1).max(100).default(20), maxChars:z.number().int().min(1000).max(64000).default(16000),
  }, {readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}, async args=>{
    try {
      const memory=sdk.memory.get(args.sourceId);
      const snippets=memory.snippets.slice(args.offset,args.offset+args.limit);
      return formatToolResponse({...memory,snippets,pagination:{offset:args.offset,limit:args.limit,nextOffset:args.offset+snippets.length<memory.snippets.length?args.offset+snippets.length:null,total:memory.snippets.length}},args.maxChars);
    } catch(err) { return formatToolError(err); }
  });
  mcp.tool('get_snippet', 'Read a retained immutable snippet version by its citation version ID. This does not retrieve discarded original source content.', {
    versionId:z.number().int().positive(), maxChars:z.number().int().min(1000).max(64000).default(16000),
  }, {readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}, async args=>{
    try { return formatToolResponse(sdk.memory.snippet(args.versionId),args.maxChars); } catch(err) { return formatToolError(err); }
  });
  mcp.tool('edit_source_memory', 'Edit retained memory using optimistic versioning. Excerpts must match observed text; new interpretation must be marked derived. This does not restore discarded original source content.', {
    sourceId:z.string(), expectedVersion:z.number().int().positive(), actor:z.string().min(1), reason:z.string().min(1), requestId:z.string().optional(), summary:z.string().max(8000).optional(),
    add:z.array(snippet).optional(), revise:z.array(z.object({id:z.string(),text:z.string().min(1).max(1200),kind:z.enum(['excerpt','derived']).optional(),locator:locator.optional(),purpose:z.string().optional()})).optional(), retire:z.array(z.string()).optional(),
    maxChars:z.number().int().min(1000).max(64000).default(16000),
  }, {readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false}, async args=>{
    try {
      const {maxChars,...edit}=args;
      return formatToolResponse(sdk.memory.edit(edit),maxChars);
    } catch(err) { return formatToolError(err); }
  });
}

export async function refreshSourceMemory(sdk:ShaleSDK, request:SourceRefreshRequest):Promise<SourceRefreshResponse> {
  const source=sdk.context.getSource(request.sourceId);
  if(!source) return {sourceId:request.sourceId,status:'unavailable',reason:'Source does not exist'};
  try {
    return await sdk.messages.request('source:refresh',request,{target:source.origin});
  } catch(error) {
    return {sourceId:source.id,status:'unavailable',reason:String(error).slice(0,300)};
  }
}
