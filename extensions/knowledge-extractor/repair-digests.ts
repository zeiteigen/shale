import { getSDK, type ShaleSDK } from '@shale/sdk';
import { digestContext, type DigestSource } from './digest-context';
import { acquireTaskLease } from '../../lib/task-lease';

/** Repair older model activities contradicted by the connector's participant records. */
export function repairUserActivities(sdk: ShaleSDK, limit = 50) {
  const lease = acquireTaskLease(sdk.database, sdk.extensionId, 'knowledge-extractor-lease');
  if (!lease) return { repaired: 0, busy: true };
  try {
    const rows = sdk.database.query<DigestSource & { revision_id: number; activity: string }, [number]>(`
      SELECT s.id AS source_id,s.title,s.type,s.uri,s.origin,s.created_at,s.updated_at,d.revision_id,d.activity
      FROM graph_source_digests d JOIN sources s ON s.id=d.source_id
      WHERE s.type='chat_session' AND s.origin!='email' AND d.activity IS NOT NULL
      ORDER BY d.digested_at DESC LIMIT ?`).all(limit);
    let repaired = 0;
    for (const source of rows) {
      if (!digestContext(sdk, source, []).userAbsent) continue;
      sdk.database.transaction(() => {
        const changed = sdk.database.query(`UPDATE graph_source_digests SET activity=NULL,
          involvement=CASE WHEN involvement IN ('participant','author') THEN 'observer' ELSE involvement END,
          episode_state='pending',episode_checked_at=NULL WHERE source_id=? AND revision_id=? AND activity=?`)
          .run(source.source_id, source.revision_id, source.activity).changes;
        if (!changed) return;
        sdk.state.setJson(`digest-activity-repair:${source.source_id}`, { revisionId: source.revision_id,
          previousActivity: JSON.parse(source.activity), reason: 'The connector does not list the user as a participant', at: Date.now() });
        repaired++;
      })();
    }
    return { repaired };
  } finally { lease.release(); }
}

if (import.meta.main) {
  const result = repairUserActivities(getSDK(import.meta.dir));
  console.log(JSON.stringify(result));
  if ('busy' in result && result.busy) process.exitCode = 2;
}
