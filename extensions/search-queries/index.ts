import { getSDK, type ShaleSDK } from "@shale/sdk";
import { ENGINES } from "./contract";
import { searchSettings } from "./settings";
import { SEARCH_QUERIES_DEFAULTS } from "./settings.types";
import { SEARCH_ORIGIN, SEARCH_SOURCE_TYPE, commitSearch } from "./source";
import { dueQueries, searchTables } from "./store";

/**
 * Write a source for every search that has been quiet for `settleMinutes`.
 * Capture arrives through subscribe.ts; this only turns the raw log into sources.
 */
export async function run(sdkOverride?: ShaleSDK, now = Date.now()) {
  const sdk = sdkOverride ?? getSDK(import.meta.dir);
  const settings = searchSettings(sdk);
  const namespace = settings.namespace || SEARCH_QUERIES_DEFAULTS.namespace;
  const settle = (settings.settleMinutes ?? SEARCH_QUERIES_DEFAULTS.settleMinutes) * 60_000;
  const rows = dueQueries(searchTables(sdk.database), now - settle,
    settings.maxQueriesPerRun ?? SEARCH_QUERIES_DEFAULTS.maxQueriesPerRun);
  const totals = { searches: rows.length, indexed: 0, errors: [] as string[] };
  for (const row of rows) {
    try {
      const result = await commitSearch(sdk, row, namespace);
      if (result.skipped) continue;
      totals.indexed++;
      try {
        await sdk.messages.publish("source:ingested", { sourceId: result.sourceId, type: SEARCH_SOURCE_TYPE, uri: result.uri,
          title: result.title, origin: SEARCH_ORIGIN, namespace, chunksCount: result.chunksCount, timestamp: Date.now() });
      } catch (error) {
        sdk.logger.warn(`Search committed but source:ingested notification failed for ${result.uri}:`, error);
      }
    } catch (error) {
      totals.errors.push(`${ENGINES[row.engine].label} "${row.query}": ${error instanceof Error ? error.message : String(error)}`);
      sdk.logger.error(`Failed to index search "${row.query}":`, error);
    }
  }
  if (rows.length) sdk.logger.log(`Search queries: indexed ${totals.indexed} of ${rows.length} search(es), ${totals.errors.length} error(s).`);
  return totals;
}

if (import.meta.main) {
  run().catch(error => { console.error("Search indexing failed:", error); process.exitCode = 1; });
}

export default run;
