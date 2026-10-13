import { getSDK, type ShaleSDK } from '@shale/sdk';
import { acquireTaskLease } from '../../lib/task-lease';
import { consolidate } from './consolidate';
import { episodeSettings } from './index';

/** Nightly: mark dormant episodes, merge split stories, and rewrite changed episodes' titles and summaries. */
export async function run(sdkOverride?: ShaleSDK) {
  const sdk = sdkOverride ?? getSDK(import.meta.dir);
  const { settings, model } = episodeSettings(sdk);
  if (!settings.enabled) return { skipped: true };
  // Shares the assignment lease: consolidation must not rewrite an episode mid-assignment.
  const lease = acquireTaskLease(sdk.database, sdk.extensionId, 'episodes-lease');
  if (!lease) return { busy: true };
  const heartbeat = setInterval(() => { try { lease.renew(); } catch { /* lost lease ends the run on release */ } }, 30_000);
  try {
    const result = await consolidate(sdk, settings, model);
    sdk.logger.log(`Episodes consolidated: ${result.rewritten} rewritten, ${result.merged} merged, ${result.dormant} now dormant.`);
    return result;
  } finally {
    clearInterval(heartbeat);
    lease.release();
  }
}

if (import.meta.main) run().catch(error => { console.error('Episode consolidation failed:', error); process.exitCode = 1; });
export default run;
