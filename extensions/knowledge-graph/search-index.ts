import { getSDK, type ShaleSDK } from '@shale/sdk';
import { acquireTaskLease } from '../../lib/task-lease';
import { indexSources } from '../../sdk/retrieval/indexer';
import { refreshPhraseDictionary } from '../../lib/text/terms';
import type { KnowledgeGraphSettings } from './settings.types';

/**
 * The search-indexer cron: keeps the fielded source index (sdk/retrieval/indexer.ts) in step with retained memory,
 * entity links, and access labels. Incremental and bounded, under a task lease so overlapping runs never race.
 * Ingestion also queues the new source (registerSearchIndexing), so search catches up within seconds.
 */
export async function run(sdkOverride?: ShaleSDK) {
  const sdk = sdkOverride ?? getSDK(import.meta.dir);
  const settings = sdk.settings.getAll() as Partial<KnowledgeGraphSettings>;
  if (settings.searchIndexEnabled === false) return { skipped: true };
  const lease = acquireTaskLease(sdk.database, sdk.extensionId, 'search-indexer-lease');
  if (!lease) return { busy: true };
  try {
    // Keyphrases are scored against the corpus phrase dictionary; a no-op when nothing changed.
    refreshPhraseDictionary(sdk.database);
    const result = indexSources(sdk.database, { limit: settings.searchIndexBatch ?? 500, deadlineMs: 60_000 });
    if (result.indexed || result.deleted) console.log(`[search-indexer] indexed ${result.indexed}, deleted ${result.deleted}, pending ${result.pending}`);
    return result;
  } finally { lease.release(); }
}

/** Index freshly ingested sources a few seconds later (batched); the cron still covers anything missed. */
export function registerSearchIndexing(sdk: ShaleSDK) {
  const queued = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    const sourceIds = [...queued];
    queued.clear();
    const settings = sdk.settings.getAll() as Partial<KnowledgeGraphSettings>;
    if (settings.searchIndexEnabled === false || !sourceIds.length) return;
    const lease = acquireTaskLease(sdk.database, sdk.extensionId, 'search-indexer-lease');
    if (!lease) return;
    try { indexSources(sdk.database, { sourceIds, deadlineMs: 5_000 }); }
    catch (error) { console.error('[search-indexer] ingestion indexing failed:', error); }
    finally { lease.release(); }
  };
  sdk.messages.on('source:ingested', event => {
    queued.add(event.sourceId);
    timer ??= setTimeout(flush, 3_000);
  });
}

if (import.meta.main) run().catch(error => { console.error('Search indexing failed:', error); process.exitCode = 1; });
export default run;
