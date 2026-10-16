import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createExtensionSDK } from '../sdk';
import { createTestDatabase } from './fixtures/database';
import { run } from '../extensions/access-classifier';
import { decide, fitKind, isStale, MODEL_VERSION, type DistilledModel, type KindModel, type LabeledItem } from '../extensions/access-classifier/distilled';
import { ensureAccessSchema, setLabel } from '../lib/access/schema';
import { validateAccessPolicy } from '../lib/access/policy';
import { recordTier } from '../lib/access/visibility';
import { sourceContentHash, type SourceContent } from '../lib/access/source-hash';

const POLICY = validateAccessPolicy({ defaultTier: 'public', unauthenticatedProfile: 'local', profiles: { local: { clearance: 'secret' } } });
const kindModel = (weights: Record<string, number[]>, epsilon = 0.05): KindModel =>
  ({ model: { classes: 4, weights, bias: [0, 0, 0, 0] }, epsilon, calibration: { items: 0, settled: 0, under: 0, accuracy: 0 } });

function setup(settings: Record<string, unknown>, model?: Partial<DistilledModel['kinds']>) {
  const db = createTestDatabase();
  const sdk = createExtensionSDK('access-classifier', { database: db });
  sdk.settings.get = ((key: string) => ({ enabled: true, llmEnabled: true, maxSourcesPerRun: 10, maxContentChars: 1000, ...settings })[key]) as typeof sdk.settings.get;
  if (model) sdk.state.set('distilled-model', JSON.stringify({ version: MODEL_VERSION, trainedAt: Date.now(), labels: 0, kinds: model }));
  const prompts: string[] = [];
  sdk.queryLLM = (async (prompt: string) => {
    prompts.push(prompt);
    return JSON.stringify({ source: { tier: 'private', reason: 'model' }, entities: [], claims: [] });
  }) as typeof sdk.queryLLM;
  const ingest = (id: string, text: string, origin = 'test') => sdk.ingest.sourceAndChunks({
    source: { id, title: id, uri: `test://${id}`, origin, type: 'note' }, chunks: [{ text_content: text }] });
  const tier = (id: string) => recordTier(db, POLICY, 'source', id);
  return { db, sdk, prompts, ingest, tier };
}

const hashOf = (db: Database, id: string) => sourceContentHash(db.query<SourceContent, [string]>('SELECT id,hash,title,uri,origin,type FROM sources WHERE id=?').get(id)!);

describe('distilled access classifier', () => {
  it('records the decision, never below the heuristic, and settles only when the model agrees or exceeds it', () => {
    const model = kindModel({ 'w:garden': [0, 6, 0, 0], 'w:diagnosis': [6, 0, 0, 0] });
    const garden = decide(model, { kind: 'source', text: 'garden notes', origins: ['test'], heuristic: 0, hard: false });
    expect(garden).toMatchObject({ predicted: 1, tier: 1, settled: true });
    // The model expects the LLM to lower a heuristic private tier: that is the LLM's call, and the record stays private.
    const lowered = decide(model, { kind: 'source', text: 'diagnosis', origins: ['test'], heuristic: 2, hard: false });
    expect(lowered).toMatchObject({ predicted: 0, tier: 2, settled: false });
    // Uncertain between tiers: the chance the LLM goes higher exceeds the bound.
    expect(decide(kindModel({}, 0.05), { kind: 'claim', text: 'x', origins: [], heuristic: 0, hard: false }).settled).toBe(false);
    expect(decide(kindModel({ 'w:garden': [0, 6, 0, 0] }, 0), { kind: 'source', text: 'garden', origins: [], heuristic: 0, hard: false }).settled).toBe(false);
  });

  it('learns from LLM labels and calibrates a tail bound on held-out records', () => {
    const items: LabeledItem[] = Array.from({ length: 600 }, (_, i) => ({
      kind: 'claim', id: `c${i}`, group: `s${i % 120}`, text: i % 2 ? `meeting agenda ${i}` : `lab results ${i}`,
      predicate: i % 2 ? 'DISCUSSED' : 'HEALTH', origins: [i % 2 ? 'obsidian' : 'email'], heuristic: 0, hard: false, label: i % 2 ? 1 : 2,
    }));
    const fitted = fitKind(items);
    expect(fitted.epsilon).toBeGreaterThan(0);
    expect(fitted.calibration.accuracy).toBe(1);
    expect(decide(fitted, { kind: 'claim', text: 'lab results', predicate: 'HEALTH', origins: ['email'], heuristic: 0, hard: false }))
      .toMatchObject({ predicted: 2, tier: 2, settled: true });
    expect(isStale(null, 10)).toBe(true);
    expect(isStale({ version: MODEL_VERSION, trainedAt: Date.now(), labels: 1000, kinds: {} }, 1050)).toBe(false);
    expect(isStale({ version: MODEL_VERSION, trainedAt: Date.now(), labels: 1000, kinds: {} }, 1100)).toBe(true);
  });

  it('active mode skips the LLM for settled sources and labels them distilled, which counts as classified', async () => {
    const { db, sdk, prompts, ingest, tier } = setup({ distilledMode: 'active' }, { source: kindModel({ 'w:garden': [0, 6, 0, 0] }) });
    ingest('garden', 'garden planting schedule');
    ingest('other', 'unrelated words');
    const result = await run(sdk);
    expect(result).toMatchObject({ distilled: 1, llm: 1 });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('unrelated words');
    expect(db.query("SELECT tier,content_hash FROM graph_access_labels WHERE kind='source' AND record_id='garden' AND origin='distilled'").get())
      .toEqual({ tier: 1, content_hash: hashOf(db, 'garden') });
    expect(tier('garden')).toBe(1);
    expect(await run(sdk)).toMatchObject({ distilled: 0, llm: 0 });
    expect(prompts).toHaveLength(1);
  });

  it('active mode leaves a source to the LLM when the model would lower its heuristic tier', async () => {
    const { sdk, prompts, ingest } = setup({ distilledMode: 'active' }, { source: kindModel({ 'w:diagnosed': [8, 0, 0, 0] }) });
    ingest('health', 'She was diagnosed and prescribed medication.');
    expect(await run(sdk)).toMatchObject({ distilled: 0, llm: 1 });
    expect(prompts).toHaveLength(1);
  });

  it('requires a confident verdict for every listed entity before skipping', async () => {
    // The entity model has learned nothing about this entity, so its tail mass is far above the bound.
    const { db, sdk, prompts, ingest } = setup({ distilledMode: 'active' }, { source: kindModel({ 'w:garden': [0, 6, 0, 0] }), entity: kindModel({}) });
    ingest('garden', 'garden planting schedule');
    const entity = sdk.graph.entities.create({ name: 'Tomato', type: 'Plant' });
    db.query('INSERT INTO source_entities(source_id,entity_id) VALUES(?,?)').run('garden', entity.id);
    expect(await run(sdk)).toMatchObject({ distilled: 0, llm: 1 });
    expect(prompts).toHaveLength(1);
  });

  it('shadow mode records the distilled verdict beside the LLM verdict without changing labels', async () => {
    const { db, sdk, prompts, ingest } = setup({}, { source: kindModel({ 'w:garden': [0, 6, 0, 0] }) });
    ingest('garden', 'garden planting schedule');
    expect(await run(sdk)).toMatchObject({ distilled: 0, llm: 1 });
    expect(prompts).toHaveLength(1);
    const row = db.query<{ verdict_json: string; llm_verdict_json: string }, []>(
      "SELECT verdict_json,llm_verdict_json FROM graph_shadow_decisions WHERE kind='access' AND subject_key='garden'").get()!;
    expect(JSON.parse(row.verdict_json)).toMatchObject({ skip: true, source: { tier: 'personal' } });
    expect(JSON.parse(row.llm_verdict_json)).toMatchObject({ source: 'private' });
    expect(db.query("SELECT count(*) n FROM graph_access_labels WHERE origin='distilled'").get()).toEqual({ n: 0 });
  });

  it('effective tiers use a current distilled label after the LLM and before the heuristic', () => {
    const { db, ingest, tier } = setup({});
    ingest('note', 'plain words');
    const hash = hashOf(db, 'note');
    setLabel(db, 'source', 'note', 'heuristic', 0, { contentHash: hash });
    expect(tier('note')).toBe(0);
    setLabel(db, 'source', 'note', 'distilled', 2, { contentHash: hash });
    expect(tier('note')).toBe(2);
    setLabel(db, 'source', 'note', 'distilled', 2, { contentHash: 'stale' });
    expect(tier('note')).toBe(0);
    setLabel(db, 'source', 'note', 'distilled', 2, { contentHash: hash });
    setLabel(db, 'source', 'note', 'llm', 1, { contentHash: hash });
    expect(tier('note')).toBe(1);
  });

  it('migrates a label table whose origin check predates distilled labels', () => {
    const db = new Database(':memory:');
    db.run(`CREATE TABLE graph_access_labels (
      kind TEXT NOT NULL CHECK(kind IN ('source','entity','claim')), record_id TEXT NOT NULL,
      origin TEXT NOT NULL CHECK(origin IN ('manual','heuristic','llm')),
      tier INTEGER NOT NULL CHECK(tier BETWEEN 0 AND 3), hard INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '', content_hash TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL,
      PRIMARY KEY(kind,record_id,origin)) STRICT`);
    db.run("INSERT INTO graph_access_labels VALUES('source','a','llm',2,1,'kept','h',5)");
    expect(() => setLabel(db, 'source', 'a', 'distilled', 1)).toThrow();
    db.run('CREATE TABLE graph_source_revisions(id INTEGER PRIMARY KEY)');
    db.run('CREATE TABLE graph_revision_passages(id INTEGER PRIMARY KEY, revision_id INTEGER, text_id INTEGER)');
    db.run('CREATE TABLE graph_memory_texts(id INTEGER PRIMARY KEY, text_content TEXT)');
    ensureAccessSchema(db);
    ensureAccessSchema(db);
    expect(db.query('SELECT * FROM graph_access_labels').all()).toEqual([
      { kind: 'source', record_id: 'a', origin: 'llm', tier: 2, hard: 1, reason: 'kept', content_hash: 'h', updated_at: 5 }]);
    setLabel(db, 'source', 'a', 'distilled', 1);
    expect(() => setLabel(db, 'source', 'a', 'bogus' as never, 1)).toThrow();
    expect(db.query("SELECT count(*) n FROM sqlite_master WHERE name='graph_access_labels_rebuild'").get()).toEqual({ n: 0 });
  });
});

