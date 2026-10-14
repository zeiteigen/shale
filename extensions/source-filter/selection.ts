import type { ShaleSDK } from '@shale/sdk';
import { graphIdentityFromSourceUri } from '../../lib/source-identity';
import type { SourceFilterSettings } from './settings.types';
import type { FilterSource, RunOptions } from './types';

type SourceRow = Omit<FilterSource, 'memory'> & { queuedAt: number };
// Passive observations with identical quality do not invalidate a content verdict.
const CONTENT_KEY = `json_array(s.hash,s.title,s.uri,s.origin,s.type,m.summary_method,m.coverage,m.availability,
  (SELECT json_extract(o.metadata,'$.quality') FROM source_observations o WHERE o.source_id=s.id
    ORDER BY o.captured_at DESC,o.id DESC LIMIT 1))`;
const CATALOG = `SELECT s.*,coalesce(m.updated_at,s.updated_at) AS queuedAt,
  coalesce(v.version,0) AS version,${CONTENT_KEY} AS contentKey FROM sources s
  LEFT JOIN source_memories m ON m.source_id=s.id
  LEFT JOIN graph_record_versions v ON v.kind='source' AND v.record_id=s.id`;

function hydrate(sdk: ShaleSDK, row: SourceRow): FilterSource {
  const hasMemory = sdk.database.query('SELECT 1 FROM source_memories WHERE source_id=?').get(row.id);
  return { ...row, memory: hasMemory ? sdk.memory.get(row.id) : null };
}

export function readSource(sdk: ShaleSDK, sourceId: string): FilterSource | null {
  const row = sdk.database.query<SourceRow, [string]>(CATALOG + ' WHERE s.id=?').get(sourceId);
  return row ? hydrate(sdk, row) : null;
}

export function selectSources(sdk: ShaleSDK, settings: SourceFilterSettings, key: string,
  options: RunOptions, dryRun: boolean): SourceRow[] {
  const selected = options.sourceIds ? JSON.stringify(options.sourceIds) : null;
  return sdk.database.query<SourceRow, [string, string | null, string | null, string, number, number, number]>(`
    WITH catalog AS (${CATALOG}) SELECT s.* FROM catalog s LEFT JOIN source_filter_decisions d ON d.source_id=s.id
    WHERE s.origin IN (SELECT value FROM json_each(?))
      AND (? IS NULL OR s.id IN (SELECT value FROM json_each(?)))
      AND (d.source_id IS NULL OR d.content_key!=s.contentKey OR d.policy_key!=?
        OR (d.decision='review' AND d.attempts<3 AND d.retry_at<=?)
        OR (d.decision='remove' AND ?=0))
    ORDER BY coalesce(d.updated_at,s.queuedAt),s.updated_at,s.id LIMIT ?`)
    .all(JSON.stringify(settings.origins), selected, selected, key, Date.now(), dryRun ? 1 : 0, settings.maxSourcesPerRun);
}

/** Browser wrapper URIs share a page identity. The list is built once per run, never from connector internals. */
export function identityGroups(sdk: ShaleSDK): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const row of sdk.database.query<{ id: string; uri: string }, []>('SELECT id,uri FROM sources').all()) {
    const identity = graphIdentityFromSourceUri(row.uri);
    const ids = groups.get(identity) ?? [];
    ids.push(row.id); groups.set(identity, ids);
  }
  return groups;
}
