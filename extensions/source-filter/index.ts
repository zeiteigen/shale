import { getSDK, type ShaleSDK } from '@shale/sdk';
import { acquireTaskLease } from '../../lib/task-lease';
import { FilterDecisions } from './decisions';
import { parseArguments } from './cli';
import { SourceProtections, protectionReason } from './protection';
import { ChangedSourceError, removeSource } from './removal';
import { reviewSource } from './review';
import { classify } from './rules';
import { readSource, selectSources } from './selection';
import { policyKey, readSettings } from './settings';
import { keep, type FilterSource, type FilterStats, type RunOptions, type StoredDecision } from './types';

export type { FilterVerdict, FilterStats, RunOptions } from './types';
export * from './settings.types';

export async function run(sdkOverride?: ShaleSDK, options: RunOptions = {}): Promise<FilterStats> {
  const sdk = sdkOverride ?? getSDK(import.meta.dir);
  const stats: FilterStats = { scanned: 0, protected: 0, kept: 0, proposed: 0, algorithmicRemoved: 0,
    llmRemoved: 0, blocked: 0, llmCalls: 0, pending: 0, failed: 0, stale: 0, busy: false };
  if (options.sourceIds && (!options.sourceIds.length || options.sourceIds.some(id => typeof id !== 'string' || !id.trim())))
    throw new Error('Select at least one nonempty source ID');
  const settings = readSettings(sdk);
  if (!settings.enabled) return stats;
  const lease = acquireTaskLease(sdk.database, sdk.extensionId, 'source-filter-lease');
  if (!lease) return { ...stats, busy: true };
  let leaseError: unknown;
  const renew = () => { if (leaseError) throw leaseError; lease.renew(); };
  const heartbeat = setInterval(() => { try { lease.renew(); } catch (error) { leaseError = error; } }, 30_000);
  try {
    const decisions = new FilterDecisions(sdk.database), protections = new SourceProtections(sdk);
    const key = policyKey(settings, sdk), deadline = Date.now() + settings.runBudgetSeconds * 1000;
    const dryRun = options.dryRun === true || settings.dryRun;
    decisions.reconcile();

    const currentSource = (id: string, contentKey?: string): FilterSource | null => {
      renew();
      const active = readSettings(sdk), source = readSource(sdk, id);
      if (!source || contentKey && source.contentKey !== contentKey || !active.enabled || policyKey(active, sdk) !== key) {
        stats.stale++; return null;
      }
      return source;
    };
    const finish = async (stored: StoredDecision) => {
      const source = currentSource(stored.sourceId, stored.contentKey);
      if (!source) return;
      const active = readSettings(sdk), protectedReason = protectionReason(source, active, protections.curated());
      if (protectedReason) {
        decisions.save({ ...stored, sourceVersion: source.version, verdict: keep(protectedReason), attempts: 0, retryAt: 0 });
        stats.protected++; stats.kept++; return;
      }
      if (stored.verdict.decision === 'keep') { stats.kept++; return; }
      if (stored.verdict.decision === 'review') { stats.pending++; return; }
      if (dryRun || active.dryRun) {
        stats.proposed++;
        sdk.logger.log(`Source filter proposal: ${JSON.stringify({ sourceId: source.id, category: stored.verdict.category,
          method: stored.verdict.method, reason: stored.verdict.reason })}`);
        return;
      }
      // The verdict was saved before removal. Recovery repairs its receipt marker if this process stops after commit.
      try {
        const blocked = await removeSource(sdk, source, stored, decisions, protections);
        stats[stored.verdict.method === 'algorithm' ? 'algorithmicRemoved' : 'llmRemoved']++;
        if (blocked) stats.blocked++;
      } catch (error) {
        if (error instanceof ChangedSourceError || error instanceof Error && error.message.startsWith('Stale source')) stats.stale++;
        else { stats.failed++; sdk.logger.warn(`Source filtering removal could not be finalized for ${source.id}; will reconcile next run:`, String(error)); }
      }
    };

    const reviews: StoredDecision[] = [];
    for (const row of selectSources(sdk, settings, key, options, dryRun)) {
      if (Date.now() >= deadline) break;
      const source = currentSource(row.id);
      if (!source) continue;
      stats.scanned++;
      const cached = decisions.get(source.id), protectedReason = protectionReason(source, settings, protections.curated());
      const stored: StoredDecision = cached?.contentKey === source.contentKey && cached.policyKey === key ? cached : {
        sourceId: source.id, contentKey: source.contentKey, policyKey: key, sourceVersion: source.version,
        verdict: classify(source), attempts: 0, retryAt: 0, appliedAt: null,
      };
      stored.sourceVersion = source.version;
      if (protectedReason) stored.verdict = keep(protectedReason);
      decisions.save(stored);
      if (stored.verdict.decision === 'review') reviews.push(stored);
      else await finish(stored);
    }

    const ready = settings.llmEnabled ? reviews.filter(item => item.attempts < 3 && item.retryAt <= Date.now())
      .slice(0, settings.maxLLMCallsPerRun) : [];
    const reviewed = await sdk.models.mapChat(ready, async stored => {
      if (Date.now() >= deadline) return stored;
      const source = currentSource(stored.sourceId, stored.contentKey);
      if (!source) return null;
      const active = readSettings(sdk);
      if (!active.llmEnabled) return stored;
      const protectedReason = protectionReason(source, active, protections.curated());
      if (protectedReason) return { ...stored, verdict: keep(protectedReason) };
      stats.llmCalls++;
      try {
        const verdict = await reviewSource(sdk, source, stored.verdict, active, deadline);
        const current = currentSource(source.id, stored.contentKey);
        if (!current) return null;
        const result = { ...stored, sourceVersion: current.version, verdict, attempts: 0, retryAt: 0, appliedAt: null };
        decisions.save(result);
        return result;
      } catch (error) {
        const current = currentSource(source.id, stored.contentKey);
        if (!current) return null;
        stats.failed++;
        const attempts = stored.attempts + 1;
        const retryAt = attempts === 1 ? Date.now() + 3_600_000 : attempts === 2 ? Date.now() + 21_600_000 : 0;
        const result = { ...stored, attempts, retryAt, verdict: { ...stored.verdict,
          reason: `Review failed (${attempts}/3): ${String(error).slice(0, 500)}` } };
        decisions.save(result);
        sdk.logger.warn(`Source filtering review failed for ${source.id}; source retained (${attempts}/3).`);
        return result;
      }
    });
    for (const stored of reviewed) if (stored) await finish(stored);
    stats.pending += reviews.length - ready.length;
    sdk.logger.log(`Source filter: ${JSON.stringify(stats)}`);
    return stats;
  } finally { clearInterval(heartbeat); lease.release(); }
}

if (import.meta.main) {
  try { await run(undefined, parseArguments(process.argv.slice(2))); }
  catch (error) { console.error('Source filter failed:', error); process.exitCode = 1; }
}
export default run;
