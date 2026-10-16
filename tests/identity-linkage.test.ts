import { afterEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createExtensionSDK } from '../sdk';
import { createTestDatabase } from './fixtures/database';
import { IdentityResolver } from '../sdk/graph/identity';
import { canonicalOf } from '../sdk/graph/registry';
import { adjudicate, settleByLinkage } from '../extensions/knowledge-graph/resolve';
import {
  acronymMatch, bandVerdict, createScorer, datesIn, DEFAULT_BANDS, emailNameMatch, FEATURES, jaroWinkler, loadModel,
  MODEL_STATE_KEY, pairFeatures, personNames, refreshModel, score, storedModel, tfidfCosine, train, type Features, type LinkageModel,
} from '../lib/graph/linkage';
import { DEFAULT_LINKAGE_MODEL } from '../lib/graph/linkage-default';
import { estimate, lshPairs, shingles, signature } from '../lib/graph/minhash';

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = createTestDatabase(); databases.push(db);
  const sdk = createExtensionSDK('knowledge-graph', { database: db, namespace: 'knowledge' });
  const resolver = new IdentityResolver(db, sdk.graph);
  const entity = (name: string, type: string, key = name) =>
    sdk.graph.entities.create({ stableId: `extracted:${key}:${type}`, name, type, namespace: 'knowledge' }).id;
  const describeAs = (id: number, text: string) => sdk.graph.claims.add({ subject: id, predicate: 'DESCRIPTION', value: text, method: 'llm' });
  let sources = 0;
  const source = (...ids: number[]) => {
    const id = `source-${++sources}`;
    db.query("INSERT INTO sources(id,type,uri,origin,created_at,title,updated_at,hash) VALUES(?,'email',?,'email',?,?,?,?)")
      .run(id, `mail:${id}`, sources * 1000, id, sources * 1000, id);
    for (const entityId of ids) db.query('INSERT INTO source_entities(source_id,entity_id) VALUES(?,?)').run(id, entityId);
    return id;
  };
  const queue = (mention: number, candidate: number) => db.query(
    "INSERT INTO graph_resolution_queue(mention_id,candidate_id,basis,created_at) VALUES(?,?,'test',?)").run(mention, candidate, Date.now());
  return { db, sdk, resolver, entity, describeAs, source, queue };
}

const features = (values: Partial<Features>) => ({ ...Object.fromEntries(FEATURES.map(name => [name, 0])), ...values }) as Features;

describe('linkage features', () => {
  it('scores names, emails, acronyms, dates, and descriptions', () => {
    expect(jaroWinkler('martha', 'marhta')).toBeCloseTo(0.961, 3);
    expect(jaroWinkler('redekop', 'redekopp')).toBeGreaterThan(0.95);
    expect(personNames('J. Redekopp', 'James Redekopp')).toEqual({ compatible: 1, conflict: 0 });
    expect(personNames('Bill Gates', 'William Gates').compatible).toBe(1);
    expect(personNames('James', 'James Redekopp').compatible).toBe(0.5);
    expect(personNames('Sonali Majumdar', 'Sharon Milgram')).toEqual({ compatible: 0, conflict: 1 });
    expect(emailNameMatch('jredekopp@school.edu', 'James Redekopp')).toBe(1);
    expect(emailNameMatch('noreply@tradingview.com', 'TradingView')).toBe(1);
    expect(emailNameMatch('someone@example.com', 'James Redekopp')).toBe(0);
    expect(acronymMatch('NHPC', 'Northbridge High Performance Computing')).toBe(true);
    expect(acronymMatch('NHPC', 'NHPC')).toBe(false);
    expect(datesIn('A sale ending August 10, 2026; renews 2026-07-20')).toEqual(['8-10', '7-20']);
    const idf = () => 1;
    expect(tfidfCosine(['robotics', 'club'], ['robotics', 'club'], idf)).toBeCloseTo(1);
    expect(tfidfCosine(['robotics'], ['poetry'], idf)).toBe(0);
  });

  it('reads pairs from the graph, splitting an already merged pair back into its sides', () => {
    const { db, sdk, entity, describeAs, source } = fixture();
    const org = entity('Northbridge Robotics', 'Organization', 'a'), mention = entity('Northbridge Robotics Club', 'Organization', 'b');
    const mentor = entity('Dana Quill', 'Person');
    describeAs(org, 'Student robotics club at Northbridge building competition robots');
    describeAs(mention, 'Northbridge student club that builds competition robots');
    source(org, mentor); source(mention, mentor);
    const before = pairFeatures(db, mention, org);
    expect(before).toMatchObject({ contained: 1, exact: 0, organization: 1, descriptionMissing: 0, coMention: 0 });
    expect(before.description).toBeGreaterThan(0.3);
    expect(before.sharedNeighbors).toBeGreaterThan(0);
    sdk.graph.entities.merge(mention, org, 'test');
    // Replaying the decided pair sees the two records, not one merged group on both sides.
    expect(pairFeatures(db, mention, org)).toEqual(before);
  });
});

describe('linkage model', () => {
  it('trains a logistic model that separates labelled pairs and survives JSON', () => {
    const examples = [
      ...Array.from({ length: 40 }, () => ({ features: features({ exact: 1, description: 0.8, sharedNeighbors: 0.5 }), label: 1 as const })),
      ...Array.from({ length: 40 }, () => ({ features: features({ exact: 1, description: 0.05, dateConflict: 1 }), label: 0 as const })),
      ...Array.from({ length: 10 }, () => ({ features: features({ jw: 0.6 }), label: 0 as const })),
    ];
    const model = JSON.parse(JSON.stringify(train(examples))) as LinkageModel;
    expect(score(model, features({ exact: 1, description: 0.8, sharedNeighbors: 0.5 }))).toBeGreaterThan(0.9);
    expect(score(model, features({ exact: 1, description: 0.05, dateConflict: 1 }))).toBeLessThan(0.1);
    // Shrinking toward a prior keeps weights near it when there is little data.
    const prior = { ...DEFAULT_LINKAGE_MODEL, weights: { ...DEFAULT_LINKAGE_MODEL.weights, numberConflict: -5 } };
    expect(train(examples.slice(0, 4), { prior, l2: 50 }).weights.numberConflict).toBeCloseTo(-5, 1);
  });

  it('applies stricter bands to people and dated things', () => {
    expect(bandVerdict(0.98, features({ organization: 1 }))).toBe('same');
    expect(bandVerdict(0.98, features({ person: 1 }))).toBeNull();
    expect(bandVerdict(0.98, features({ person: 1, sharedNeighbors: 0.4 }))).toBe('same');
    expect(bandVerdict(0.99, features({ event: 1, dateConflict: 1 }))).toBeNull();
    expect(bandVerdict(0.99, features({ event: 1, dateMatch: 1 }))).toBe('same');
    expect(bandVerdict(0.99, features({ organization: 1, coParticipant: 1 }))).toBeNull();
    expect(bandVerdict(DEFAULT_BANDS.different / 2, features({ person: 1 }))).toBe('different');
  });

  it('ships default weights, refits from model verdicts, and stores the model in extension state', () => {
    const { db, entity, queue, describeAs } = fixture();
    expect(loadModel(db)).toBe(DEFAULT_LINKAGE_MODEL);
    for (let index = 0; index < 12; index++) {
      const a = entity(`Lab ${index}`, 'Organization', `a${index}`), b = entity(`Lab ${index}`, 'Organization', `b${index}`);
      describeAs(a, `research lab number ${index}`); describeAs(b, `research lab number ${index}`);
      queue(b, a);
      db.query("UPDATE graph_resolution_queue SET state=?,reason='model verdict',decided_at=? WHERE mention_id=?").run(index % 3 ? 'same' : 'different', index, b);
    }
    // Rule decisions are not labels.
    db.query("UPDATE graph_resolution_queue SET reason='same Organization name' WHERE mention_id=(SELECT max(mention_id) FROM graph_resolution_queue)").run();
    expect(refreshModel(db, { minLabels: 20 }).refit).toBe(false);
    const { model, refit } = refreshModel(db, { minLabels: 10 });
    expect(refit).toBe(true);
    expect(model.labels).toBe(11);
    expect(storedModel(db)).toEqual(model);
    expect(db.query('SELECT 1 FROM extension_state WHERE extension_id=? AND state_key=?').get('knowledge-graph', MODEL_STATE_KEY)).toBeTruthy();
    // A fresh model is not refit until enough new verdicts arrive.
    expect(refreshModel(db, { minLabels: 10 }).refit).toBe(false);
    const scorer = createScorer(db);
    const p = scorer(db, entity('Lab 99', 'Organization', 'x'), entity('Lab 99', 'Organization', 'y'));
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
  });
});

describe('cannot-link constraints', () => {
  it('refuses a merge chain A~B, B~C when A and C were told apart', () => {
    const { db, resolver, entity, queue } = fixture();
    const a = entity('Atlas', 'Project', 'a'), b = entity('Atlas project', 'Project', 'b'), c = entity('Atlas app', 'Project', 'c');
    queue(c, a);
    resolver.decide(c, a, 'different', 0.9, 'different products');
    queue(b, a);
    resolver.decide(b, a, 'same', 0.95, 'same project');
    expect(canonicalOf(db, b)).toBe(a);
    queue(c, b);
    resolver.decide(c, b, 'same', 0.95, 'same project');
    expect(canonicalOf(db, c)).toBe(c);
    expect(resolver.cannotLink(c, b)).toBe('judged different');
    expect(db.query<{ reason: string }, [number, number]>('SELECT reason FROM graph_resolution_queue WHERE mention_id=? AND candidate_id=?')
      .get(c, b)!.reason).toContain('merge refused: judged different');
  });

  it('keeps two parties of one event and distinct accounts apart', () => {
    const { db, sdk, resolver, entity, queue } = fixture();
    const sender = entity('Richard', 'Person', 'a'), recipient = entity('Richard', 'Person', 'b');
    const transfer = entity('Transfer', 'Event');
    sdk.graph.claims.add({ subject: transfer, predicate: 'ROLE:sender', object: sender, method: 'llm' });
    sdk.graph.claims.add({ subject: transfer, predicate: 'ROLE:recipient', object: recipient, method: 'llm' });
    expect(resolver.cannotLink(sender, recipient)).toStartWith('co-participants');
    queue(recipient, sender);
    resolver.decide(recipient, sender, 'same', 0.95, 'same name');
    expect(canonicalOf(db, recipient)).toBe(recipient);

    const one = entity('Sam', 'Person', 'c'), two = entity('Sam', 'Person', 'd');
    sdk.graph.entities.addAlias(one, '111', 'key:discord-user');
    sdk.graph.entities.addAlias(two, '222', 'key:discord-user');
    expect(resolver.cannotLink(one, two)).toBe('distinct discord accounts');
    expect(resolver.cannotLink(one, two, 'hard')).toBeNull();
  });
});

describe('near-duplicate blocking', () => {
  it('estimates 3-gram Jaccard with MinHash and finds typo pairs with LSH', () => {
    const a = shingles('James Redekopp'), b = shingles('James Redekop'), c = shingles('Northbridge Robotics');
    expect(estimate(signature(a, 128), signature(b, 128))).toBeGreaterThan(0.6);
    expect(estimate(signature(a, 128), signature(c, 128))).toBeLessThan(0.2);
    const pairs = lshPairs([{ key: 'a', signature: signature(a) }, { key: 'b', signature: signature(b) }, { key: 'c', signature: signature(c) }]);
    expect(pairs).toContainEqual(['a', 'b']);
    expect(pairs.some(pair => pair.includes('c'))).toBe(false);
  });

  it('queues near-duplicate names of one family once, without exact keys', () => {
    const { db, resolver, entity } = fixture();
    const first = entity('James Redekopp', 'Person'), typo = entity('James Redekop', 'Person');
    entity('James Redekopp', 'Organization', 'org');
    entity('Unrelated Name', 'Person');
    expect(resolver.sweepNearDuplicates(10)).toBe(1);
    expect(db.query('SELECT mention_id AS m,candidate_id AS c,substr(basis,1,8) AS b FROM graph_resolution_queue').all())
      .toEqual([{ m: typo, c: first, b: 'minhash:' }]);
    expect(resolver.sweepNearDuplicates(10)).toBe(0);
  });
});

describe('settleByLinkage', () => {
  const sure = (bias: number): LinkageModel => ({ ...DEFAULT_LINKAGE_MODEL, bias, weights: {} });

  it('records shadow scores, leaves pairs to the model, and attaches its verdict', async () => {
    const { db, sdk, resolver, entity, queue } = fixture();
    const a = entity('Lumiere Education', 'Organization', 'a'), b = entity('Lumiere Education Group', 'Organization', 'b');
    queue(b, a);
    expect(await settleByLinkage(sdk, resolver, sure(8), { linkageMode: 'shadow' })).toEqual({ scored: 1, settled: 0 });
    expect(canonicalOf(db, b)).toBe(b);
    sdk.queryLLM = (async (_prompt: string) => '{"decisions":[{"pair":1,"verdict":"same","confidence":0.9,"reason":"expansion"}]}') as typeof sdk.queryLLM;
    await adjudicate(sdk, resolver, 8);
    const row = db.query<{ verdict_json: string; llm_verdict_json: string }, [string]>(
      "SELECT verdict_json,llm_verdict_json FROM graph_shadow_decisions WHERE kind='identity' AND method='linkage' AND subject_key=?").get(`${b}:${a}`)!;
    expect(JSON.parse(row.verdict_json)).toMatchObject({ verdict: 'same' });
    expect(JSON.parse(row.llm_verdict_json)).toEqual({ verdict: 'same', confidence: 0.9 });
    expect(await settleByLinkage(sdk, resolver, sure(8), { linkageMode: 'off' })).toEqual({ scored: 0, settled: 0 });
  });

  it('settles confident pairs in active mode and sends the rest to the model', async () => {
    const { db, sdk, resolver, entity, queue } = fixture();
    const a = entity('Lumiere Education', 'Organization', 'a'), b = entity('Lumiere Education Group', 'Organization', 'b');
    const c = entity('Alice Chen', 'Person', 'c'), d = entity('Alice Chen', 'Person', 'd');
    queue(b, a); queue(d, c);
    // People also need relational evidence, so the person pair stays with the model.
    expect(await settleByLinkage(sdk, resolver, sure(8), { linkageMode: 'active' })).toEqual({ scored: 2, settled: 1 });
    expect(canonicalOf(db, b)).toBe(a);
    expect(db.query<{ reason: string }, []>('SELECT reason FROM graph_identity_changes').get()!.reason).toStartWith('Record linkage');
    expect(db.query<{ state: string; reason: string }, [number]>('SELECT state,reason FROM graph_resolution_queue WHERE mention_id=?').get(b))
      .toMatchObject({ state: 'same', reason: expect.stringMatching(/^linkage p=/) });
    expect(resolver.pending(10)).toEqual([expect.objectContaining({ mention_id: d, candidate_id: c })]);
    expect(await settleByLinkage(sdk, resolver, sure(-8), { linkageMode: 'active' })).toEqual({ scored: 1, settled: 1 });
    expect(db.query<{ state: string }, [number]>('SELECT state FROM graph_resolution_queue WHERE mention_id=?').get(d)!.state).toBe('different');
  });
});
