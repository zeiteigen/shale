import type { ShaleSDK } from "../sdk";
import type { ClaimFilter, ClaimStatus, TraversalOptions } from "../sdk/graph/types";

/** Local graph inspection/correction endpoints, guarded by the server's origin checks. */
export async function knowledgeApi(req: Request, url: URL, sdk: ShaleSDK): Promise<Response | undefined> {
  const match = url.pathname.match(/^\/api\/knowledge\/(claims|inspect|review|traverse|entity|merge|unmerge|event|revision|memory)$/);
  if (!match) return;
  try {
    if (req.method === 'GET') {
      if (match[1] === 'memory') {
        const sourceId = url.searchParams.get('sourceId');
        if (!sourceId) throw new Error('A source ID is required');
        return Response.json(sdk.memory.get(sourceId));
      }
      if (match[1] === 'entity') return Response.json(sdk.graph.entities.inspect(Number(url.searchParams.get('id'))));
      if (match[1] === 'claims') {
        const entityId=url.searchParams.has('entityId') ? Number(url.searchParams.get('entityId')) : undefined;
        if (entityId!==undefined && !Number.isSafeInteger(entityId)) throw new Error('Invalid entity ID');
        return Response.json({claims:sdk.graph.claims.list({entityId,limit:200})});
      }
      if (match[1] === 'inspect') return Response.json(sdk.graph.inspect(url.searchParams.get('id') ?? ''));
      if (match[1] === 'event') return Response.json(sdk.graph.events.get(Number(url.searchParams.get('id'))));
      if (match[1] === 'revision') return Response.json(sdk.graph.evidence.revision(Number(url.searchParams.get('id'))));
    }
    if (req.method === 'POST') {
      const body = await req.json();
      if (match[1] === 'event') return Response.json({events:sdk.graph.events.list(body)});
      if (match[1] === 'claims') return Response.json({claims:sdk.graph.claims.list(body as ClaimFilter)});
      if (match[1] === 'review') {
        const review=body as {id:string;status:ClaimStatus;actor:string;reason:string};
        return Response.json(sdk.graph.lifecycle.review(review.id,review.status,review.actor,review.reason));
      }
      if (match[1] === 'traverse') return Response.json(sdk.graph.query.traverse(body as TraversalOptions));
      if (match[1] === 'entity') return Response.json(sdk.graph.entities.rename(body.id,body.name));
      if (match[1] === 'merge') return Response.json({changeId:sdk.graph.entities.merge(body.from,body.into,body.reason)});
      if (match[1] === 'unmerge') {sdk.graph.entities.unmerge(body.changeId);return Response.json({success:true});}
    }
    return Response.json({error:'Method not allowed'}, {status:405});
  } catch (error) {
    return Response.json({error:error instanceof Error ? error.message : 'Invalid graph request'}, {status:400});
  }
}
