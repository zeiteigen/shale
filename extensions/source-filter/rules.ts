import type { FilterSource, FilterVerdict } from './types';
import { keep } from './types';
import { sourceFeatures, type SourceFeatures } from './features';

const PAGE_TYPES = new Set(['web_page', 'public_web_page', 'web_page_version', 'public_web_page_version']);
const OBSERVATION_TYPES = new Set(['browser_activity', 'browser_history', 'web_session', 'web_search', 'youtube_video']);

/** A missing body is weak evidence. Only an affirmative, completely retained failure shell is decisive. */
export function classify(source: FilterSource, features: SourceFeatures = sourceFeatures(source),
  options: { nearDuplicateMinCopies?: number } = {}): FilterVerdict {
  if (!source.memory || source.memory.availability !== 'retained') return keep('Retained evidence is unavailable; keep for refresh');
  if (PAGE_TYPES.has(source.type) && features.fullyRetained && !features.payloadLines.length
    && (features.failureLines.length || source.memory.coverage.inputCharacters === 0 && /^(?:untitled|new tab|blank|about:blank)?$/i.test(source.title.trim()))) {
    return { decision: 'remove', category: 'capture_failure', method: 'algorithm', confidence: 1,
      reason: 'Complete capture contains only an empty, error, login, or challenge shell',
      signals: ['capture failure without useful payload'], quotations: features.failureLines.slice(0, 3) };
  }
  const signals: string[] = [];
  if (features.lines.length && features.boilerplateRatio >= .8) signals.push('At least 80% boilerplate lines');
  if (features.lines.length >= 8 && features.repetitionRatio >= .7) signals.push('At least 70% repeated lines');
  if (features.urls >= 5 && features.linkRatio >= .7) signals.push('At least 70% URL characters across five links');
  if (features.promotionCues >= 2) signals.push('Multiple promotional or scam cues');
  // Bulk templates are a reason to look, never a reason to remove: digests and receipts repeat too.
  const copies = features.nearDuplicates ?? 0, minCopies = options.nearDuplicateMinCopies ?? 3;
  if (minCopies > 0 && copies >= minCopies) signals.push(`Near-duplicate of ${copies} other sources`);
  if (signals.length) return { decision: 'review', category: 'unknown', method: 'algorithm', confidence: 0,
    reason: 'Suspicious signals require a content judgment', signals, quotations: [] };
  if (!features.hasObservedText && !OBSERVATION_TYPES.has(source.type)) return keep('Missing observed excerpts do not establish noise');
  return keep(OBSERVATION_TYPES.has(source.type) ? 'Meaningful activity or metadata observation without noise signals'
    : 'No clear-noise signals; topic and content length do not determine usefulness');
}
