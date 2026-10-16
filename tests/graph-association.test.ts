import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExtensionSDK, type ShaleSDK } from '../sdk';
import { closeScopedSDKs, createScopedSDK } from '../sdk/access';
import { createTestDatabase } from './fixtures/database';
import { associationId, commitAssociations, computeAssociations, g2, strengthOf } from '../lib/graph/association';
import { reasonAssociations, reasonRules, run } from '../extensions/knowledge-graph/reason';

const directory = mkdtempSync(join(tmpdir(), 'shale-association-'));
const databases: Database[] = [];
let counter = 0;
afterEach(() => { closeScopedSDKs(); for (const db of databases.splice(0)) db.close(); });
afterAll(() => rmSync(directory, { recursive: true, force: true }));

function fixture() {
  writeFileSync(process.env.SHALE_ACCESS_PATH!, JSON.stringify({ defaultTier: 'personal', unauthenticatedProfile: 'local', originTiers: { discord: 'private' },
    profiles: { local: { clearance: 'secret' }, cloud: { clearance: 'personal' } } }));
  const db = createTestDatabase(join(directory, `graph-${counter++}.db`)); databases.push(db);
  const sdk = createExtensionSDK('knowledge-graph', { database: db, namespace: 'knowledge' });
  const entity = (name: string, type = 'Organization') => sdk.graph.entities.create({ name, type }).id;
  const source = (id: string, origin: string, text: string, entities: number[]) => {
    sdk.ingest.sourceAndChunks({ source: { id, uri: `${origin}://${id}`, title: id, origin, type: 'note', hash: `${id}-v1` }, chunks: [{ text_content: text }] });
    for (const entityId of entities) db.query('INSERT OR IGNORE INTO source_entities(source_id,entity_id) VALUES(?,?)').run(id, entityId);
  };
  return { db, sdk, entity, source };
}

/** Thirty filler notes, each with its own entity, so co-occurrence is measured against a realistic background. */
function background(source: ReturnType<typeof fixture>['source'], entity: ReturnType<typeof fixture>['entity']) {
  for (let i = 0; i < 30; i++) source(`filler-${i}`, 'obsidian', `Filler ${i}`, [entity(`Filler ${i}`, 'Concept')]);
}

describe('association edges', () => {
  it('scores co-occurrence with Dunning G², positive association only', () => {
    expect(g2(10, 0, 0, 90)).toBeGreaterThan(60);
    expect(g2(1, 9, 9, 81)).toBeCloseTo(0, 6);
    expect(g2(3, 1, 2, 94)).toBeCloseTo(g2(3, 2, 1, 94), 6);
    expect(strengthOf(0)).toBe(0);
    expect(strengthOf(40)).toBeCloseTo(0.632, 3);
  });

  it('links entities that keep appearing together, skipping self, Episodes, connector containers, and ubiquitous entities', () => {
    const { db, sdk, entity, source } = fixture();
    background(source, entity);
    const acme = entity('Acme'), rocket = entity('Rocket Program', 'Opportunity'), lone = entity('Lone Corp');
    const self = sdk.graph.entities.create({ stableId: 'self', name: 'Me', type: 'Person' }).id;
    const episode = entity('Applying to Acme', 'Episode'), page = entity('acme.com/jobs', 'WebPage');
    const everywhere = entity('Mail Provider');
    for (let i = 0; i < 3; i++) source(`acme-${i}`, 'obsidian', `Acme rocket ${i}`, [acme, rocket, self, episode, page, everywhere]);
    source('lone', 'obsidian', 'Lone', [lone, acme, everywhere]);
    for (let i = 0; i < 25; i++) db.query('INSERT INTO source_entities(source_id,entity_id) VALUES(?,?)').run(`filler-${i}`, everywhere);
    const result = computeAssociations(db, { maxDocFraction: 0.3, minG2: 3.84 });
    const pairs = result.edges.map(edge => [edge.a, edge.b]);
    expect(pairs).toContainEqual([Math.min(acme, rocket), Math.max(acme, rocket)]);
    for (const excluded of [self, episode, page, everywhere, lone]) expect(pairs.flat()).not.toContain(excluded);
    const edge = result.edges.find(item => item.a === Math.min(acme, rocket))!;
    expect(edge).toMatchObject({ cooccurrences: 3 });
    expect(edge.pmi).toBeGreaterThan(0);
    expect(edge.sources.sort()).toEqual(['acme-0', 'acme-1', 'acme-2']);
  });

  it('writes idempotent, grounded ASSOCIATED_WITH claims, retracts stale ones, and feeds search expansion', async () => {
    const { db, sdk, entity, source } = fixture();
    background(source, entity);
    const acme = entity('Acme'), rocket = entity('Rocket Program', 'Opportunity');
    for (let i = 0; i < 3; i++) source(`acme-${i}`, 'obsidian', `Acme runs the rocket program, part ${i}.`, [acme, rocket]);
    const { edges } = computeAssociations(db, { minG2: 3.84, scale: 2 });
    expect(commitAssociations(db, sdk.graph, edges)).toMatchObject({ created: 1, retracted: 0 });
    const id = associationId(acme, rocket);
    const claim = sdk.graph.claims.get(id);
    expect(claim).toMatchObject({ predicate: 'ASSOCIATED_WITH', method: 'association', status: 'proposed', subject: Math.min(acme, rocket) });
    expect(claim.qualifiers).toMatchObject({ cooccurrences: 3 });
    expect(claim.confidence).toBe(claim.strength);
    expect(sdk.graph.relations.get('ASSOCIATED_WITH')?.symmetric).toBe(true);
    expect(sdk.graph.evidence.list(id).map(item => item.sourceId).sort()).toEqual(['acme-0', 'acme-1', 'acme-2']);
    expect(commitAssociations(db, sdk.graph, edges)).toMatchObject({ created: 0, updated: 0 });

    // Search expansion seeds from entities mentioned in retrieved chunks, then traverses proposed links at or above its
    // confidence floor (0.6); this one is strong.
    db.query("INSERT INTO chunk_entities(chunk_id,entity_id) SELECT id,? FROM chunks WHERE source_id='acme-0'").run(rocket);
    const search = await sdk.search.graph({ query: 'rocket program', mode: 'bm25', graph: { maxDepth: 1 } });
    expect(search.neighborhoods.flatMap(neighborhood => neighborhood.claims.map(item => item.id))).toContain(id);
    db.query('UPDATE graph_claims SET confidence=0.3 WHERE id=?').run(id);
    const weak = await sdk.search.graph({ query: 'rocket program', mode: 'bm25', graph: { maxDepth: 1 } });
    expect(weak.neighborhoods.flatMap(neighborhood => neighborhood.claims.map(item => item.id))).not.toContain(id);

    db.run("DELETE FROM source_entities WHERE source_id IN ('acme-1','acme-2')");
    expect(commitAssociations(db, sdk.graph, computeAssociations(db, { minG2: 3.84, scale: 2 }).edges)).toMatchObject({ retracted: 1 });
    expect(sdk.graph.claims.get(id).status).toBe('retracted');
  });

  it('shows an association only to profiles that can see a source it was counted in', () => {
    const { db, sdk, entity, source } = fixture();
    background(source, entity);
    const alice = entity('Alice Example', 'Person'), clinic = entity('Northside Clinic');
    const acme = entity('Acme'), rocket = entity('Rocket Program', 'Opportunity');
    // Alice and the clinic are each known from notes, but only private DMs put them together.
    source('note-alice', 'obsidian', 'Alice notes', [alice]);
    source('note-clinic', 'obsidian', 'Clinic notes', [clinic]);
    for (let i = 0; i < 3; i++) source(`dm-${i}`, 'discord', `Alice clinic visit ${i}`, [alice, clinic]);
    for (let i = 0; i < 3; i++) source(`acme-${i}`, 'obsidian', `Acme rocket ${i}`, [acme, rocket]);
    commitAssociations(db, sdk.graph, computeAssociations(db, { minG2: 3.84, scale: 2 }).edges);
    const visible = (base: ShaleSDK, profile: string) => createScopedSDK(profile, base).read.graph.claims
      .list({ predicate: 'ASSOCIATED_WITH', statuses: ['proposed'] }).map(claim => claim.id).sort();
    expect(visible(sdk, 'local')).toEqual([associationId(acme, rocket), associationId(alice, clinic)].sort());
    expect(visible(sdk, 'cloud')).toEqual([associationId(acme, rocket)]);
  });

  it('records would-be edges and conclusions in shadow mode beside the model, and writes them only when active', async () => {
    const { db, sdk, entity, source } = fixture();
    background(source, entity);
    const acme = entity('Acme'), rocket = entity('Rocket Program', 'Opportunity'), me = entity('Ada Byron', 'Person');
    for (let i = 0; i < 3; i++) source(`acme-${i}`, 'obsidian', `Acme rocket ${i}`, [acme, rocket]);
    sdk.graph.claims.add({ subject: acme, predicate: 'suggested_connection', object: rocket, method: 'llm' });
    sdk.graph.claims.add({ subject: me, predicate: 'applied_to', object: rocket, method: 'llm' });
    sdk.graph.claims.add({ subject: rocket, predicate: 'offered_by', object: acme, method: 'llm' });
    const settings = { associationMinG2: 3.84 };
    expect(reasonAssociations(sdk, 'shadow', settings).edges).toBe(1);
    expect(reasonRules(sdk, 'shadow', settings).perRule).toEqual({ 'applied-offered': 1 });
    const shadow = db.query<{ subject_key: string; method: string; llm_verdict_json: string | null }, []>(
      "SELECT subject_key,method,llm_verdict_json FROM graph_shadow_decisions WHERE kind='relation' ORDER BY method").all();
    expect(shadow.map(row => row.method)).toEqual(['association', 'rule:applied-offered']);
    expect(JSON.parse(shadow[0]!.llm_verdict_json!).relations).toContain(`${acme}>suggested_connection>${rocket}`);
    expect(db.query("SELECT count(*) AS n FROM graph_claims WHERE method='association' OR method GLOB 'rule:*'").get()).toEqual({ n: 0 });
    expect(reasonAssociations(sdk, 'active', settings)).toMatchObject({ created: 1 });
    expect(reasonRules(sdk, 'active', settings)).toMatchObject({ created: 1 });
    // The cron itself (settings default to shadow) holds a lease and reports every stage.
    const report = await run(sdk) as { mode: string; patterns: { sources: number } };
    expect(report.mode).toBe('shadow');
  });
});
