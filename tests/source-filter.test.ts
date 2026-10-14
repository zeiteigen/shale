import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { run } from '../extensions/source-filter';
import { FilterDecisions } from '../extensions/source-filter/decisions';
import { readSource } from '../extensions/source-filter/selection';
import { SOURCE_FILTER_DEFAULTS } from '../extensions/source-filter/settings.types';
import { closeScopedSDKs, createScopedSDK } from '../sdk/access';
import { filterFixture, SPAM, spamVerdict } from './fixtures/source-filter';

const fixtures: ReturnType<typeof filterFixture>[] = [];
const setup = (settings: Parameters<typeof filterFixture>[0] = {}, fileBacked = false) => {
  const fixture = filterFixture(settings, fileBacked); fixtures.push(fixture); return fixture;
};
afterEach(() => { closeScopedSDKs(); for (const fixture of fixtures.splice(0)) fixture.close(); });

describe('source filter removal and protection', () => {
  it('keeps ordinary sources without model calls and archives temporary failures without blocking repaired captures', async () => {
    const { sdk, db, ingest, prompts } = setup();
    ingest('useful', 'A substantive explanation of durable SQLite transactions.');
    ingest('broken', '404 Not Found');
    const result = await run(sdk);
    expect(result).toMatchObject({ kept: 1, algorithmicRemoved: 1, llmCalls: 0, blocked: 0 });
    expect(prompts).toHaveLength(0);
    expect(db.query('SELECT * FROM graph_source_archives').all()).toHaveLength(1);
    expect(db.query('SELECT * FROM graph_source_exclusions').all()).toHaveLength(0);
    ingest('broken', 'The repaired page contains an explanation of WAL checkpoints.');
    expect((await run(sdk)).kept).toBe(1);
    expect(sdk.memory.get('broken').summary.text).toContain('WAL');
  });

  it('removes grounded high-confidence spam from search, retains evidence, blocks recapture, and protects manual restoration', async () => {
    const { sdk, db, ingest } = setup();
    ingest('spam', SPAM + ' uniquespamword');
    const entity = sdk.graph.entities.create({ name: 'Shared organization', type: 'Organization' });
    const claim = sdk.graph.claims.add({ subject: entity.id, predicate: 'DESCRIPTION', value: 'Advertised a reward', status: 'accepted',
      evidence: [{ sourceId: 'spam', chunkIndex: 1, quote: 'claim your prize' }] });
    const citation = sdk.graph.evidence.list(claim.id)[0]!;
    const result = await run(sdk);
    expect(result).toMatchObject({ llmCalls: 1, llmRemoved: 1, blocked: 1 });
    expect(await sdk.search.bm25({ query: 'uniquespamword' })).toHaveLength(0);
    expect(sdk.graph.claims.get(claim.id).status).toBe('stale');
    expect(sdk.graph.evidence.list(claim.id)[0]!.revisionId).toBe(citation.revisionId);
    expect(sdk.graph.entities.get(entity.id).name).toBe('Shared organization');
    expect(sdk.ingest.sourceAndChunks({ source: { id: 'replacement', title: 'spam', uri: 'https://example.test/spam', type: 'web_page', origin: 'browser' },
      chunks: [{ text_content: SPAM }] }).skipped).toBe('excluded');
    await sdk.knowledge.mutate('restore_source', { sourceId: 'spam', unblockReingestion: true }, { actor: 'curator', reason: 'Keep this evidence' });
    expect((await run(sdk)).protected).toBe(1);
    expect(db.query('SELECT * FROM sources WHERE id=?').get('spam')).toBeTruthy();
  });

  it('protects bookmarks, notes, local documents, explicit IDs, canonical URI patterns, and exact manual audit references', async () => {
    const { sdk, ingest, settings, db } = setup({ protectedSourceIds: ['explicit'], protectedUriPatterns: ['https://keep.test/*'] });
    ingest('bookmark', SPAM, { type: 'bookmark' });
    ingest('note', SPAM, { origin: 'obsidian', type: 'markdown_note' });
    ingest('document', SPAM, { origin: 'directories', type: 'document' });
    ingest('explicit', SPAM);
    ingest('uri', SPAM, { uri: 'browser-history:https://keep.test/path' });
    ingest('curated', SPAM);
    await sdk.knowledge.mutate('update_source', { sourceId: 'curated', title: 'Curated record' }, { actor: 'curator', reason: 'Keep it' });
    ingest('uncurated', SPAM);
    const result = await run(sdk);
    expect(result).toMatchObject({ protected: 4, llmCalls: 1, llmRemoved: 1 });
    expect(db.query('SELECT id FROM sources').all()).toHaveLength(6);
    settings({ protectedSourceIds: [], protectedUriPatterns: [] });
    expect((await run(sdk)).llmRemoved).toBe(2);
  });

  it('does not block browser identities shared by a bookmark or a useful capture', async () => {
    const { sdk, ingest, db } = setup();
    ingest('spam', SPAM, { uri: 'browser-history:https://shared.test/page' });
    ingest('useful', 'An independent useful article about schema design.', { uri: 'https://shared.test/page' });
    expect((await run(sdk)).blocked).toBe(0);
    expect(db.query('SELECT * FROM sources WHERE id=?').get('useful')).toBeTruthy();
    ingest('another-spam', SPAM, { uri: 'browser-history:https://bookmarked.test/page' });
    ingest('bookmark', 'A bookmarked page', { type: 'bookmark', uri: 'browser-bookmark:1:https://bookmarked.test/page' });
    expect((await run(sdk)).blocked).toBe(0);
    expect(db.query('SELECT * FROM graph_source_exclusions').all()).toHaveLength(0);
  });

  it('persists dry-run proposals and applies them without another model call', async () => {
    const { sdk, ingest, db, prompts, settings } = setup({ dryRun: true });
    ingest('spam', SPAM);
    expect(await run(sdk)).toMatchObject({ proposed: 1, llmCalls: 1, llmRemoved: 0 });
    expect(db.query('SELECT * FROM sources').all()).toHaveLength(1);
    expect(db.query('SELECT * FROM graph_source_exclusions').all()).toHaveLength(0);
    expect((await run(sdk)).scanned).toBe(0);
    settings({ dryRun: false });
    expect(await run(sdk)).toMatchObject({ llmCalls: 0, llmRemoved: 1, blocked: 1 });
    expect(prompts).toHaveLength(1);
  });

  it('uses the source budget and explicit preview selection without touching other captures', async () => {
    const { sdk, ingest, db } = setup({ maxSourcesPerRun: 1 });
    ingest('a', '404 Not Found'); ingest('b', '404 Not Found');
    expect(await run(sdk, { dryRun: true, sourceIds: ['b'] })).toMatchObject({ scanned: 1, proposed: 1, algorithmicRemoved: 0 });
    expect(db.query('SELECT * FROM sources').all()).toHaveLength(2);
    expect(await run(sdk, { sourceIds: ['b'] })).toMatchObject({ scanned: 1, algorithmicRemoved: 1 });
    expect(readSource(sdk, 'a')).toBeTruthy();
    expect(await run(sdk)).toMatchObject({ scanned: 1, algorithmicRemoved: 1 });
  });
});

describe('source filter model boundaries and recovery', () => {
  it('accepts fenced model JSON and keeps model-confirmed temporary failures recapturable', async () => {
    const { sdk, ingest, reviewer, db } = setup();
    ingest('partial-shell', 'Home\nMenu\nSearch\nSign in\nPassword\nEmail\nClose\nContinue\nUnknown text');
    reviewer(() => '```json\n' + spamVerdict({ category: 'capture_failure', quotations: ['Sign in'] }) + '\n```');
    expect(await run(sdk)).toMatchObject({ llmCalls: 1, llmRemoved: 1, blocked: 0 });
    expect(db.query('SELECT * FROM graph_source_exclusions').all()).toHaveLength(0);
    ingest('partial-shell', 'Recovered full content about a project milestone.');
    expect((await run(sdk)).kept).toBe(1);
  });

  it('keeps low-confidence, mixed, unsure, ungrounded, and truncated reviews', async () => {
    const { sdk, ingest, reviewer, db, settings } = setup();
    const verdicts = [spamVerdict({ confidence: .7 }), spamVerdict({ decision: 'keep', category: 'useful' }),
      spamVerdict({ decision: 'unsure' }), spamVerdict({ quotations: ['invented evidence'] }), spamVerdict({ quotations: [] })];
    reviewer(() => verdicts.shift()!);
    for (let index = 0; index < 5; index++) ingest(`s${index}`, SPAM);
    expect(await run(sdk)).toMatchObject({ kept: 5, llmCalls: 5, llmRemoved: 0, failed: 0 });
    settings({ maxContentChars: 500 });
    ingest('long', SPAM + '\n' + 'Additional text '.repeat(100));
    reviewer(() => spamVerdict());
    expect((await run(sdk, { sourceIds: ['long'] })).llmRemoved).toBe(0);
    expect(db.query('SELECT id FROM sources').all()).toHaveLength(6);
  });

  it('uses model budgets and leaves disabled or deferred reviews live', async () => {
    const { sdk, ingest, prompts, settings } = setup({ llmEnabled: false });
    ingest('a', SPAM); ingest('b', SPAM);
    expect(await run(sdk)).toMatchObject({ pending: 2, llmCalls: 0 });
    settings({ llmEnabled: true, maxLLMCallsPerRun: 1 });
    expect(await run(sdk)).toMatchObject({ pending: 1, llmCalls: 1, llmRemoved: 1 });
    expect(await run(sdk)).toMatchObject({ pending: 0, llmCalls: 1, llmRemoved: 1 });
    expect(prompts).toHaveLength(2);
  });

  it('caches unchanged reviews, ignores budget changes, and invalidates content, capture quality, or classification settings', async () => {
    const { sdk, ingest, settings, reviewer, prompts } = setup();
    reviewer(() => spamVerdict({ decision: 'keep', category: 'useful' }));
    ingest('candidate', SPAM);
    expect((await run(sdk)).llmCalls).toBe(1);
    ingest('candidate', SPAM);
    settings({ maxLLMCallsPerRun: 4, maxSourcesPerRun: 20 });
    expect((await run(sdk)).llmCalls).toBe(0);
    ingest('candidate', SPAM, { quality: 'partial' });
    expect((await run(sdk)).llmCalls).toBe(1);
    ingest('candidate', SPAM + ' Revised offer.');
    expect((await run(sdk)).llmCalls).toBe(1);
    settings({ removeConfidence: .95 });
    expect((await run(sdk)).llmCalls).toBe(1);
    expect(prompts).toHaveLength(4);
  });

  it('backs off malformed or failed reviews and stops after three attempts until the policy changes', async () => {
    const { sdk, ingest, db, reviewer, settings } = setup();
    ingest('candidate', SPAM);
    reviewer(() => 'invalid JSON');
    expect((await run(sdk)).failed).toBe(1);
    let stored = new FilterDecisions(db).get('candidate')!;
    expect(stored.attempts).toBe(1); expect(stored.retryAt).toBeGreaterThan(Date.now() + 3_500_000);
    expect((await run(sdk)).llmCalls).toBe(0);
    db.run('UPDATE source_filter_decisions SET retry_at=0');
    reviewer(() => { throw new Error('Model offline'); });
    expect((await run(sdk)).failed).toBe(1);
    stored = new FilterDecisions(db).get('candidate')!;
    expect(stored.attempts).toBe(2); expect(stored.retryAt).toBeGreaterThan(Date.now() + 21_500_000);
    db.run('UPDATE source_filter_decisions SET retry_at=0');
    expect((await run(sdk)).failed).toBe(1);
    expect((await run(sdk)).llmCalls).toBe(0);
    settings({ removeConfidence: .95 });
    reviewer(() => spamVerdict({ decision: 'keep' }));
    expect((await run(sdk)).llmCalls).toBe(1);
    expect(new FilterDecisions(db).get('candidate')!.attempts).toBe(0);
  });

  it('discards a verdict when content or filtering settings change during model review', async () => {
    const { sdk, ingest, reviewer, settings, db } = setup();
    ingest('candidate', SPAM);
    reviewer(() => { ingest('candidate', 'A useful project update.'); return spamVerdict(); });
    expect(await run(sdk)).toMatchObject({ stale: 1, llmRemoved: 0 });
    ingest('policy', SPAM);
    reviewer(() => { settings({ enabled: false }); return spamVerdict(); });
    expect((await run(sdk)).llmRemoved).toBe(0);
    expect(db.query('SELECT id FROM sources').all()).toHaveLength(2);
  });

  it('honors protections added during review and just before audited application', async () => {
    const { sdk, ingest, reviewer, db } = setup();
    ingest('candidate', SPAM);
    reviewer(async () => {
      const current = sdk.memory.get('candidate');
      sdk.memory.edit({ sourceId: 'candidate', expectedVersion: current.version, actor: 'curator', reason: 'Keep', summary: current.summary.text });
      return spamVerdict();
    });
    expect((await run(sdk)).llmRemoved).toBe(0);
    ingest('late', SPAM);
    reviewer(() => spamVerdict());
    const apply = sdk.knowledge.apply.bind(sdk.knowledge);
    sdk.knowledge.apply = (input, before) => {
      const current = sdk.memory.get('late');
      sdk.memory.edit({ sourceId: 'late', expectedVersion: current.version, actor: 'curator', reason: 'Keep', summary: current.summary.text });
      return apply(input, before);
    };
    expect(await run(sdk)).toMatchObject({ llmRemoved: 0, stale: 1 });
    expect(db.query('SELECT * FROM sources WHERE id=?').get('late')).toBeTruthy();
  });

  it('rechecks useful identity peers inside the audited writer transaction', async () => {
    const { sdk, ingest, db } = setup();
    ingest('spam', SPAM, { uri: 'browser-history:https://late-peer.test/page' });
    const apply = sdk.knowledge.apply.bind(sdk.knowledge);
    sdk.knowledge.apply = (input, before) => {
      ingest('new-peer', 'A useful independent capture.', { uri: 'https://late-peer.test/page' });
      return apply(input, before);
    };
    expect(await run(sdk)).toMatchObject({ stale: 1, llmRemoved: 0, blocked: 0 });
    expect(db.query('SELECT * FROM graph_source_exclusions').all()).toHaveLength(0);
    sdk.knowledge.apply = apply;
    expect(await run(sdk)).toMatchObject({ llmCalls: 0, llmRemoved: 1, blocked: 0 });
  });

  it('serializes overlapping runs with a persistent lease and resumes missing receipt markers', async () => {
    const { sdk, ingest, reviewer, db } = setup();
    ingest('candidate', SPAM);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const paused = new Promise<void>(resolve => { release = resolve; });
    reviewer(async () => { entered(); await paused; return spamVerdict(); });
    const first = run(sdk);
    await started;
    expect((await run(sdk)).busy).toBe(true);
    release();
    expect((await first).llmRemoved).toBe(1);
    db.run('UPDATE source_filter_decisions SET applied_at=NULL');
    await run(sdk);
    expect(new FilterDecisions(db).get('candidate')!.appliedAt).not.toBeNull();
    expect(db.query('SELECT * FROM graph_changes').all()).toHaveLength(1);
    expect(sdk.state.get('source-filter-lease')).toBeNull();
  });

  it('aborts review at the run deadline while retaining the candidate', async () => {
    const { sdk, ingest, reviewer, db } = setup({ runBudgetSeconds: 1 });
    ingest('candidate', SPAM);
    reviewer((_prompt, options) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    }));
    expect(await run(sdk)).toMatchObject({ failed: 1, pending: 1, llmRemoved: 0 });
    expect(db.query('SELECT * FROM sources').all()).toHaveLength(1);
  });

  it('keeps private cached decisions hidden from scoped graph consumers', async () => {
    const { sdk, ingest, db } = setup({ dryRun: true }, true);
    // A consumer may already be connected before the first scheduled filter run creates its table.
    const scoped = createScopedSDK('cloud', sdk);
    ingest('candidate', SPAM);
    await run(sdk);
    expect(db.query('SELECT * FROM source_filter_decisions').all()).toHaveLength(1);
    scoped.refresh();
    expect(scoped.read.database.query('SELECT * FROM source_filter_decisions').all()).toHaveLength(0);
    expect(() => scoped.read.database.run('DELETE FROM main.sources')).toThrow();
  });

  it('runs synchronous preconditions under the writer lock and rolls back failures without an audit', async () => {
    const { sdk, ingest, dbPath, db } = setup({}, true);
    const source = ingest('candidate', SPAM);
    const other = new Database(dbPath);
    try {
      await expect(sdk.knowledge.apply({ actor: 'extension:source-filter', reason: 'Guarded removal', operations: [
        { type: 'remove_source', args: { sourceId: source.id, expectedVersion: source.version } },
      ] }, () => {
        expect(() => other.run("UPDATE sources SET title='Concurrent edit' WHERE id='candidate'")).toThrow();
        throw new Error('Precondition failed');
      })).rejects.toThrow('Precondition failed');
      expect(db.query('SELECT * FROM graph_changes').all()).toHaveLength(0);
      expect(readSource(sdk, 'candidate')).toBeTruthy();
    } finally { other.close(); }
  });

  it('validates settings and optional source selection before doing work', async () => {
    const { sdk, settings } = setup();
    await expect(run(sdk, { sourceIds: [] })).rejects.toThrow('nonempty');
    settings({ maxSourcesPerRun: 1.5 });
    await expect(run(sdk)).rejects.toThrow();
    settings({ maxSourcesPerRun: SOURCE_FILTER_DEFAULTS.maxSourcesPerRun, enabled: false });
    expect((await run(sdk)).scanned).toBe(0);
  });

  it('rejects asynchronous write preconditions without mutating sources', async () => {
    const { sdk, ingest, db } = setup();
    ingest('candidate', SPAM);
    await expect(sdk.knowledge.apply({ actor: 'extension:source-filter', reason: 'Async preconditions are unsupported',
      operations: [{ type: 'remove_source', args: { sourceId: 'candidate' } }] }, async () => {})).rejects.toThrow('synchronous');
    expect(db.query('SELECT * FROM graph_changes').all()).toHaveLength(0);
    expect(readSource(sdk, 'candidate')).toBeTruthy();
  });
});
