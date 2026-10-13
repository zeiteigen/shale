import type { ShaleSDK } from '@shale/sdk';

/** New episode evidence can make an earlier unmatched source useful context. */
export function reconsiderContext(sdk: ShaleSDK, recencyDays: number) {
  const window = recencyDays * 86_400_000;
  return sdk.database.query(`WITH RECURSIVE root(id,top) AS (
      SELECT id,id FROM entities WHERE canonical_id IS NULL
      UNION SELECT e.id,root.top FROM entities e JOIN root ON e.canonical_id=root.id),
    signals AS (SELECT DISTINCT s.source_id,root.top AS entity_id FROM graph_digest_signals s
      JOIN root ON root.id=s.entity_id JOIN entities e ON e.id=root.top
      WHERE e.type IN ('Organization','Project','Course','Opportunity')),
    meaningful AS (SELECT entity_id FROM signals GROUP BY entity_id
      HAVING (SELECT count(*) FROM graph_source_digests WHERE signals_at IS NOT NULL)<20
        OR count(*)<=(SELECT count(*) FROM graph_source_digests WHERE signals_at IS NOT NULL)/2.0)
    UPDATE graph_source_digests AS d SET episode_state='pending' WHERE d.episode_state='none' AND EXISTS(
      SELECT 1 FROM signals s JOIN meaningful m ON m.entity_id=s.entity_id JOIN root ON root.top=s.entity_id
      JOIN graph_claims c ON c.object_id=root.id AND c.predicate='INVOLVES' AND c.status IN ('accepted','proposed')
      JOIN graph_episodes g ON g.entity_id=c.subject_id JOIN entities e ON e.id=g.entity_id AND e.canonical_id IS NULL
      WHERE s.source_id=d.source_id AND g.status!='closed'
        AND max(g.updated_at,coalesce(g.consolidated_at,0))>=coalesce(d.episode_checked_at,0)
        AND coalesce(d.occurred_to,d.occurred_from,g.started_at,0)>=coalesce(g.started_at,d.occurred_to,d.occurred_from,0)-?
        AND coalesce(d.occurred_from,d.occurred_to,g.last_activity_at,0)<=coalesce(g.last_activity_at,d.occurred_from,d.occurred_to,0)+?
    )`).run(window, window).changes;
}
