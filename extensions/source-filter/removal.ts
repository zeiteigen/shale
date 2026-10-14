import { createHash } from 'node:crypto';
import type { ShaleSDK } from '@shale/sdk';
import { graphIdentityFromSourceUri } from '../../lib/source-identity';
import { FilterDecisions } from './decisions';
import { readSettings, policyKey } from './settings';
import { identityGroups, readSource } from './selection';
import { SourceProtections, protectionReason } from './protection';
import { classify } from './rules';
import type { SourceFilterSettings } from './settings.types';
import type { FilterSource, StoredDecision } from './types';

export class ChangedSourceError extends Error {}

/** Exclusions affect every browser wrapper of a URL, so a useful sibling must remain recapturable. */
function canBlock(sdk: ShaleSDK, source: FilterSource, settings: SourceFilterSettings,
  protections: SourceProtections, decisions: FilterDecisions, key: string): boolean {
  const ids = identityGroups(sdk).get(graphIdentityFromSourceUri(source.uri)) ?? [];
  const curated = protections.curated();
  for (const id of ids) {
    if (id === source.id) continue;
    const sibling = readSource(sdk, id);
    if (!sibling) continue;
    if (protectionReason(sibling, settings, curated)) return false;
    const stored = decisions.get(id);
    // An uncertain sibling is also insufficient grounds for a permanent identity-wide block.
    const verdict = stored?.contentKey === sibling.contentKey && stored.policyKey === key ? stored.verdict : classify(sibling);
    if (verdict.decision !== 'remove' || verdict.category === 'capture_failure') return false;
  }
  return true;
}

export async function removeSource(sdk: ShaleSDK, source: FilterSource, stored: StoredDecision,
  decisions: FilterDecisions, protections: SourceProtections): Promise<boolean> {
  const settings = readSettings(sdk);
  const block = stored.verdict.category !== 'capture_failure'
    && canBlock(sdk, source, settings, protections, decisions, stored.policyKey);
  const requestId = 'source-filter:' + createHash('sha256').update(JSON.stringify([
    source.id, source.contentKey, stored.policyKey, source.version, block,
  ])).digest('hex');
  await sdk.knowledge.apply({ actor: 'extension:source-filter', requestId,
    reason: `${stored.verdict.category}: ${stored.verdict.reason}`.slice(0, 1000),
    operations: [{ type: 'remove_source', args: { sourceId: source.id, expectedVersion: source.version, blockReingestion: block } }],
  }, () => {
    const current = readSource(sdk, source.id), currentSettings = readSettings(sdk);
    if (!current || current.contentKey !== source.contentKey || current.version !== source.version
      || !currentSettings.enabled || currentSettings.dryRun || policyKey(currentSettings, sdk) !== stored.policyKey
      || protectionReason(current, currentSettings, protections.curated())
      || block && !canBlock(sdk, current, currentSettings, protections, decisions, stored.policyKey))
      throw new ChangedSourceError('Source, protections, identity peers, or filtering policy changed before removal');
  });
  try { decisions.markApplied(source.id, stored.contentKey, stored.policyKey); }
  catch { sdk.logger.warn(`Source ${source.id} was archived; its filter receipt marker will be repaired on the next run.`); }
  return block;
}
