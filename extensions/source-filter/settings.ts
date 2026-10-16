import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ShaleSDK } from '@shale/sdk';
import { SOURCE_FILTER_DEFAULTS, type SourceFilterSettings } from './settings.types';

const strings = z.array(z.string().trim().min(1).max(2000)).max(1000);
const schema = z.object({
  enabled: z.boolean(), dryRun: z.boolean(), llmEnabled: z.boolean(),
  maxSourcesPerRun: z.number().int().min(1).max(5000),
  maxLLMCallsPerRun: z.number().int().min(0).max(200),
  maxContentChars: z.number().int().min(500).max(50000),
  runBudgetSeconds: z.number().int().min(1).max(3600),
  removeConfidence: z.number().min(.9).max(1),
  nearDuplicateMinCopies: z.number().int().min(0).max(1000),
  nearDuplicateDistance: z.number().int().min(0).max(3),
  llmModel: z.string().trim().min(1).nullable(),
  origins: strings, protectedSourceIds: strings, protectedUriPatterns: strings,
});

export function readSettings(sdk: ShaleSDK): SourceFilterSettings {
  return schema.parse({ ...SOURCE_FILTER_DEFAULTS, ...sdk.settings.getAll<Partial<SourceFilterSettings>>() });
}

/** Execution budgets and dry-run mode do not change what content means. */
export function policyKey(settings: SourceFilterSettings, sdk: ShaleSDK): string {
  return createHash('sha256').update(JSON.stringify(['source-filter-v1', settings.removeConfidence,
    settings.maxContentChars, settings.llmModel ?? sdk.llm.options().model,
    // Absent from older keys so existing decisions stay valid until near-duplicate settings change.
    ...(settings.nearDuplicateMinCopies === 3 && settings.nearDuplicateDistance === 3 ? [] : [[settings.nearDuplicateMinCopies, settings.nearDuplicateDistance]]),
    [...settings.origins].sort(), [...settings.protectedSourceIds].sort(), [...settings.protectedUriPatterns].sort()])).digest('hex');
}
