import { getSDK, type ShaleSDK } from '@shale/sdk';
import { acquireTaskLease } from '../../lib/task-lease';
import { assign, DEFAULTS } from './assign';
import type { EpisodesSettings } from './settings.types';

export function episodeSettings(sdk: ShaleSDK) {
  const stored = sdk.settings.getAll() as Partial<EpisodesSettings>;
  const settings = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as Array<keyof typeof DEFAULTS>) {
    const value = stored[key];
    if (value !== undefined && value !== null && typeof value === typeof DEFAULTS[key]) (settings as Record<string, unknown>)[key] = value;
  }
  return { settings, model: stored.llmModel || undefined };
}

/** Assign newly digested sources to episodes. */
export async function run(sdkOverride?: ShaleSDK) {
  const sdk = sdkOverride ?? getSDK(import.meta.dir);
  const { settings, model } = episodeSettings(sdk);
  if (!settings.enabled) return { skipped: true };
  const lease = acquireTaskLease(sdk.database, sdk.extensionId, 'episodes-lease');
  if (!lease) return { busy: true };
  const heartbeat = setInterval(() => { try { lease.renew(); } catch { /* lost lease ends the run on release */ } }, 30_000);
  try {
    const result = await assign(sdk, settings, model);
    if (result.processed || result.merged || result.pruned) sdk.logger.log(`Episodes: ${result.processed} source(s) assigned, `
      + `${result.reviewed} reviewed by the model, ${result.merged} same-titled episode(s) folded, ${result.pruned} unsupported member(s) detached.`);
    return result;
  } finally {
    clearInterval(heartbeat);
    lease.release();
  }
}

if (import.meta.main) run().catch(error => { console.error('Episode assignment failed:', error); process.exitCode = 1; });
export default run;
