import type { ShaleSDK } from '@shale/sdk';
import { createHash } from 'node:crypto';

/** Source linking must reach the connector's actual note, page, image, or record. */
export function bindConnectorSources(sdk: ShaleSDK, namespace: string, sources: Map<string,number>) {
  for (const [sourceId,subject] of sources) {
    const revision = sdk.database.query<{id:number;uri:string}, [string]>(`SELECT r.id,r.uri
      FROM graph_source_revisions r JOIN sources s ON s.id=r.source_id AND s.hash=r.hash WHERE s.id=?`).get(sourceId);
    if (!revision) continue;
    for (const entity of sdk.graph.entities.resolve(sourceId,'source-id')) {
      if (entity.id === subject) continue;
      const id = `source-binding:${createHash('sha256').update(JSON.stringify([namespace,subject,entity.id,revision.id])).digest('hex')}`;
      if (sdk.database.query('SELECT 1 FROM graph_claims WHERE id=?').get(id)) continue;
      sdk.graph.claims.add({id,namespace,subject,object:entity.id,predicate:'REPRESENTS',context:revision.uri,
        status:'accepted',method:'source-identity',evidence:[{sourceId,revisionId:revision.id,method:'source-identity'}]});
    }
  }
}
