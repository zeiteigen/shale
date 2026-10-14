import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExtensionSDK, type LLMOptions, type ShaleSDK } from '../../sdk';
import { createTestDatabase } from './database';
import { SOURCE_FILTER_DEFAULTS, type SourceFilterSettings } from '../../extensions/source-filter/settings.types';
import { readSource } from '../../extensions/source-filter/selection';

export const SPAM = 'Limited time offer! Buy now to claim your prize. Guaranteed income for everyone.';
export const spamVerdict = (patch: Record<string, unknown> = {}) => JSON.stringify({ decision: 'remove', category: 'spam',
  confidence: .99, reason: 'Unsolicited promotional scam without substantive information', quotations: ['Buy now'], ...patch });

export function filterFixture(initial: Partial<SourceFilterSettings> = {}, fileBacked = false) {
  const directory = mkdtempSync(join(tmpdir(), 'shale-source-filter-'));
  const dbPath = fileBacked ? join(directory, 'test.db') : ':memory:';
  const db = createTestDatabase(dbPath);
  const sdk = createExtensionSDK('source-filter', { database: db, extensionDir: directory });
  let configuration = { ...SOURCE_FILTER_DEFAULTS, ...initial };
  const settings = (patch: Partial<SourceFilterSettings>) => {
    configuration = { ...configuration, ...patch };
    writeFileSync(join(directory, 'settings.json'), JSON.stringify(configuration));
  };
  settings({});
  const prompts: string[] = [];
  const reviewer = (handler: (prompt: string, options: LLMOptions) => string | Promise<string>) => {
    sdk.queryLLM = (async (prompt: string, options: LLMOptions) => {
      prompts.push(prompt); return handler(prompt, options);
    }) as ShaleSDK['queryLLM'];
  };
  reviewer(() => spamVerdict());
  const ingest = (id: string, text: string, overrides: { origin?: string; type?: string; uri?: string; title?: string;
    quality?: 'full' | 'partial' | 'metadata' } = {}) => {
    sdk.ingest.sourceAndChunks({ source: { id, title: overrides.title ?? id, uri: overrides.uri ?? `https://example.test/${id}`,
      type: overrides.type ?? 'web_page', origin: overrides.origin ?? 'browser', observation: { quality: overrides.quality ?? 'full' } },
      chunks: [{ text_content: text }] });
    return readSource(sdk, id)!;
  };
  return { db, dbPath, sdk, settings, prompts, reviewer, ingest,
    close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}
