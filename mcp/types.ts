import type { ShaleSDK } from "../sdk";
import { toolErrorDetails } from "./errors";

/**
 * Resolves an entity ID from either a numeric ID or a name string.
 * If a name is passed, queries `graph.entities.resolve(name)`.
 * Throws a clear error if no matching entity or multiple matching entities exist.
 */
export function resolveEntityId(
  sdk: ShaleSDK,
  identifier: number | string,
  fieldLabel = "entity",
): number {
  if (typeof identifier === "number") {
    return identifier;
  }

  const numeric = Number(identifier);
  if (Number.isInteger(numeric) && String(numeric) === identifier.trim()) {
    return numeric;
  }

  const trimmed = identifier.trim();
  const resolved = sdk.graph.entities.resolve(trimmed);
  if (resolved.length === 0) {
    throw new Error(
      `Could not resolve ${fieldLabel} "${identifier}". No matching entity found in graph.`,
    );
  }
  if (resolved.length > 1) {
    const candidates = resolved.map((e) => `#${e.id} "${e.name}" (${e.type})`).join(", ");
    throw new Error(
      `Ambiguous ${fieldLabel} "${identifier}". Multiple matches found: ${candidates}. Please specify the numeric entity ID.`,
    );
  }

  return resolved[0].id;
}

export function formatToolResponse(data: unknown, maxChars = 16_000) {
  const bounded = boundResponse(data, Math.max(1_000, Math.min(64_000, maxChars)));
  return {
    content: [
      {
        type: "text" as const,
        text: typeof bounded === "string" ? bounded : JSON.stringify(bounded),
      },
    ],
  };
}

function boundResponse(value: unknown, budget: number): unknown {
  const fits = (candidate: unknown) => JSON.stringify(candidate).length <= budget;
  if (fits(value)) return value;
  if (typeof value !== 'object' || value === null) return { truncated: true, value: String(value).slice(0, budget - 64) };
  const copy = structuredClone(value) as any;
  if(Number.isInteger(copy.totalSources) && Array.isArray(copy.hits)) {
    const omitted={relatedPassages:0,evidence:0,neighborhoods:0};
    const graphFields=Object.keys(omitted) as Array<keyof typeof omitted>;
    const withGraphOmissions=()=>({...copy,graphTruncated:true,truncated:true,omittedGraphItems:omitted});
    for(const field of graphFields) {
      const items=copy[field];
      if(!Array.isArray(items)) continue;
      while(items.length && JSON.stringify(withGraphOmissions()).length>budget) {
        items.pop(); omitted[field]++;
      }
    }
    if(Object.values(omitted).some(count=>count>0)) Object.assign(copy,withGraphOmissions());
  }
  const arrays: Array<{ parent:any; key:string }> = [];
  let omittedItems=0;
  const visit = (node:any) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      if (Array.isArray(child)) { arrays.push({ parent:node,key }); visit(child); }
      else visit(child);
    }
  };
  visit(copy);
  for (const entry of arrays) {
    const parent=entry.parent;
    const pagination=parent.pagination && Number.isInteger(parent.pagination.offset) && Number.isInteger(parent.pagination.limit)
      ? parent.pagination
      : Number.isInteger(parent.offset) && Number.isInteger(parent.limit) && (Number.isInteger(parent.total) || Number.isInteger(parent.totalSources))
        ? parent : undefined;
    if(!pagination) continue;
    const pagedKey=Number.isInteger(parent.totalSources) ? 'hits' : parent.pagination ? 'snippets' :
      ['entities','sources','chunks','claims','connections'].find(key=>Array.isArray(parent[key]));
    if(entry.key!==pagedKey) continue;
    while (parent[entry.key].length>1 && !fits(copy)) {
      parent[entry.key].pop(); omittedItems++;
      const kept=parent[entry.key].length;
      if(kept===0) return {truncated:true,omitted:true};
      pagination.limit=kept;
      const total=parent.totalSources ?? parent.total ?? pagination.total;
      const next=kept+pagination.offset < total ? kept+pagination.offset : null;
      if(parent.nextOffset!==undefined) parent.nextOffset=next;
      if(pagination.nextOffset!==undefined) pagination.nextOffset=next;
      parent.truncated=true;
    }
  }
  if (!fits(copy)) return boundedReceipt(copy,budget) ?? { truncated: true, omitted: true };
  if(omittedItems) { copy.truncated=true; copy.omittedItems=omittedItems; }
  return fits(copy) ? copy : {truncated:true,omitted:true};
}

function boundedReceipt(value:any,budget:number):unknown {
  const receipt:any={truncated:true};
  for(const key of ['success','changeId','auditChangeId','requestId','sourceId','version','status','counts','count','affectedClaimCount','total','requiresReviewCount'])
    if(value[key]!==undefined) receipt[key]=value[key];
  if(value.requiresReview!==undefined) {
    receipt.requiresReview=Array.isArray(value.requiresReview) ? value.requiresReview.slice() : value.requiresReview;
    while(Array.isArray(receipt.requiresReview) && receipt.requiresReview.length && JSON.stringify(receipt).length>budget-64) receipt.requiresReview.pop();
    if(Array.isArray(value.requiresReview) && receipt.requiresReview.length<value.requiresReview.length) {
      receipt.requiresReviewCount=value.requiresReview.length;
      receipt.requiresReviewTruncated=true;
    }
  }
  const hasReceipt=Object.keys(receipt).some(key=>key!=='truncated');
  return hasReceipt && JSON.stringify(receipt).length<=budget ? receipt : undefined;
}

export function formatToolError(error: unknown) {
  const details = toolErrorDetails(error);
  return {
    isError: true,
    structuredContent: { error: details },
    content: [
      {
        type: "text" as const,
        text: `Error: ${details.message}`,
      },
    ],
  };
}
