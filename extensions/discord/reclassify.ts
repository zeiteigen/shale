import { getSDK, type ShaleSDK } from "@shale/sdk";
import { indexChatWindows, withChatLease } from "@shale/sdk/chat/commit";
import { discordConnector, discordSettings } from "./connector";
import { DiscordRelevancePolicy } from "./relevance";
import { reclassifyArchived } from "./reclassify-archived";
import { trimDiscordArchive } from "./archive";

/** Reclassify stored history without importing files or collecting more Discord messages. */
export async function run(sdkOverride?: ShaleSDK, options: { drain?: boolean; retryPending?: boolean } = {}) {
  const sdk = sdkOverride ?? getSDK(import.meta.dir);
  return withChatLease(sdk, async () => {
    const totals = { batches: 0, windows: 0, accepted: 0, excluded: 0, pending: 0, evicted: 0, errors: [] as string[] };
    if (options.retryPending) sdk.database.query(`UPDATE discord_windows SET next_attempt_at=0
      WHERE extension_id=? AND EXISTS(SELECT 1 FROM discord_relevance r
        WHERE r.extension_id=discord_windows.extension_id AND r.window_id=discord_windows.window_id AND r.status='pending')`)
      .run(sdk.extensionId);
    // A drain is still finite and each batch obeys the usual window, model, and time budgets.
    const deadline = Date.now() + 60 * 60_000;
    do {
      const settings = discordSettings(sdk), connector = discordConnector(sdk, settings);
      const policy = connector.policy as DiscordRelevancePolicy;
      await policy.start();
      const limit = settings.relevanceMaxWindows ?? 50;
      const indexed = await indexChatWindows(sdk, connector, settings, { maxWindows: limit, deadline: policy.deadline });
      const archived = await reclassifyArchived(policy, limit - indexed.windows);
      policy.stats.evicted = trimDiscordArchive(sdk, connector.store, discordSettings(sdk)).evicted;
      sdk.state.setJson("relevance:last", policy.stats);
      totals.batches++; totals.windows += indexed.windows + archived.windows;
      for (const key of ["accepted", "excluded", "pending", "evicted"] as const) totals[key] += policy.stats[key];
      totals.errors.push(...indexed.errors, ...archived.errors);
      sdk.logger.log(`Discord cleanup batch ${totals.batches}: ${policy.stats.accepted} accepted, ${policy.stats.excluded} excluded, ${policy.stats.pending} pending.`);
      if (!options.drain || !indexed.windows && !archived.windows || Date.now() >= deadline) break;
      // The next batch has a fresh model budget; outages and missing identity keep their deferral.
      sdk.database.query(`UPDATE discord_windows SET next_attempt_at=0 WHERE extension_id=?
        AND EXISTS(SELECT 1 FROM discord_relevance r WHERE r.extension_id=discord_windows.extension_id
          AND r.window_id=discord_windows.window_id AND r.status='pending' AND r.reason='Classifier run budget exhausted')`)
        .run(sdk.extensionId);
    } while (true);
    sdk.state.setJson("relevance:cleanup", { ...totals, finishedAt: Date.now() });
    return totals;
  });
}

if (import.meta.main) run(undefined, { drain: process.argv.includes("--drain"), retryPending: process.argv.includes("--retry-pending") })
  .then(result => console.log(JSON.stringify(result)))
  .catch(error => { console.error("Discord cleanup failed:", error); process.exitCode = 1; });

export default run;
