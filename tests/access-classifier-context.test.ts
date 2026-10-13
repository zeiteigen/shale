import { expect, it } from 'bun:test';
import { createExtensionSDK } from '../sdk';
import { createTestDatabase } from './fixtures/database';
import { run } from '../extensions/access-classifier';

it('classifies successive sources after truncating their text context', async () => {
  const db = createTestDatabase();
  try {
    const sdk = createExtensionSDK('access-classifier', { database: db });
    sdk.settings.get = ((key: string) => ({ enabled: true, llmEnabled: true, maxSourcesPerRun: 4,
      maxContentChars: 100 } as Record<string, unknown>)[key]) as typeof sdk.settings.get;
    for (let i = 0; i < 4; i++) sdk.ingest.sourceAndChunks({
      source: { id: `source-${i}`, title: `Guide ${i}`, uri: `test://${i}`, origin: 'test', type: 'note' },
      chunks: [{ text_content: 'Long source context. '.repeat(100) }, { text_content: 'Another retained section.' }],
    });
    let requests = 0;
    sdk.queryLLM = (async (prompt: string) => {
      requests++;
      const text = JSON.parse(prompt.split('Content: ')[1].split('\nEntities: ')[0]);
      expect(text.length).toBe(100);
      return JSON.stringify({ source: { tier: 'personal', reason: 'Ordinary guide. '.repeat(30) }, entities: [], claims: [] });
    }) as typeof sdk.queryLLM;
    expect(await run(sdk)).toMatchObject({ llm: 4, failed: 0 });
    expect(requests).toBe(4);
    expect(db.query("SELECT count(*) n FROM graph_access_labels WHERE kind='source' AND origin='llm' AND length(reason)=300")
      .get()).toEqual({ n: 4 });
  } finally { db.close(); }
});

it('reserves enough output for large classification batches without logging rejected response bodies', async () => {
  const db = createTestDatabase();
  try {
    const sdk = createExtensionSDK('access-classifier', { database: db });
    sdk.settings.get = ((key: string) => ({ enabled: true, llmEnabled: true, maxSourcesPerRun: 1,
      maxContentChars: 100 } as Record<string, unknown>)[key]) as typeof sdk.settings.get;
    sdk.ingest.sourceAndChunks({ source: { id: 'large', title: 'Large guide', uri: 'test://large', origin: 'test', type: 'note' },
      chunks: [{ text_content: 'A guide to many projects.' }] });
    for (let i = 0; i < 40; i++) {
      const entity = sdk.graph.entities.create({ name: `Project ${i}`, type: 'Project' });
      db.query('INSERT INTO source_entities(source_id,entity_id) VALUES(?,?)').run('large', entity.id);
      sdk.graph.claims.add({ id: `long-claim-identifier-${'x'.repeat(50)}-${i}`, subject: entity.id, predicate: 'DESCRIPTION',
        value: 'Project in the guide', evidence: [{ sourceId: 'large' }], method: 'connector' });
    }
    sdk.queryLLM = (async (_prompt: string, options: { maxTokens?: number }) => {
      expect(options.maxTokens).toBeGreaterThan(4096);
      expect(options.maxTokens).toBeLessThanOrEqual(16_384);
      throw Object.assign(new Error('Output truncated'), { content: 'Rejected model response body' });
    }) as typeof sdk.queryLLM;
    const warnings: unknown[][] = [];
    sdk.logger.warn = (...args: unknown[]) => { warnings.push(args); };
    expect(await run(sdk)).toMatchObject({ llm: 0, failed: 1 });
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings)).toContain('Output truncated');
    expect(JSON.stringify(warnings)).not.toContain('Rejected model response body');
  } finally { db.close(); }
});
