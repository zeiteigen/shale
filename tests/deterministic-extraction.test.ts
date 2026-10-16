import { afterEach, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createExtensionSDK } from '../sdk';
import { createTestDatabase } from './fixtures/database';
import { run } from '../extensions/knowledge-extractor';
import { run as recover } from '../extensions/knowledge-extractor/recover';
import { deterministicExtraction, extractiveSummary, mergeDeterministic, structuralInvolvement } from '../extensions/knowledge-extractor/deterministic';
import { indexEntity } from '../sdk/graph/registry';
import { SELF_STABLE_ID } from '../sdk/graph/identity';

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const TEXT = 'The Lumiere Research Scholar Program is run by Northbridge Labs. Applications close Oct 15, 2026, 11:59 PM EST. Ask Priya about it.';

function fixture(settings: Record<string, unknown> = {}) {
  const db = createTestDatabase(); databases.push(db);
  const sdk = createExtensionSDK('knowledge-extractor', { database: db, namespace: 'knowledge' });
  const all = { enabled: true, maxSourcesPerRun: 5, maxContentChars: 12000, namespace: 'knowledge', llmModel: 'test-model', ...settings };
  sdk.settings.get = ((key: string) => (all as Record<string, unknown>)[key]) as typeof sdk.settings.get;
  const org = sdk.graph.entities.create({ name: 'Northbridge Labs', type: 'Organization', namespace: 'knowledge' });
  const program = sdk.graph.entities.create({ name: 'Lumiere Research Scholar Program', type: 'Opportunity', namespace: 'knowledge' });
  indexEntity(db, org.id); indexEntity(db, program.id);
  sdk.ingest.sourceAndChunks({ source: { id: 'mail', uri: 'file:///mail.txt', title: 'Lumiere', origin: 'test', type: 'note', hash: 'v1',
    created_at: Date.parse('2026-10-01T00:00:00Z'), updated_at: Date.parse('2026-10-01T00:00:00Z') }, chunks: [{ text_content: TEXT }] });
  let calls = 0;
  const prompts: string[] = [];
  sdk.queryLLM = (async (prompt: string) => {
    calls++; prompts.push(prompt);
    return JSON.stringify({
      entities: [{ key: 'org', name: 'Northbridge Labs', type: 'Organization', match: org.id }, { key: 'priya', name: 'Priya', type: 'Person' },
        { key: 'program', name: 'Lumiere Research Scholar Program', type: 'Opportunity' }],
      claims: [{ subject: 'program', predicate: 'is_offered_by', object: 'org', evidence: [{ chunkIndex: 0, quote: 'run by Northbridge Labs' }] },
        { subject: 'program', predicate: 'closes', value: 'Oct 15, 2026', evidence: [{ chunkIndex: 0, quote: 'Applications close Oct 15, 2026, 11:59 PM EST.' }],
          validTo: Date.parse('2026-10-16T04:59:00Z') }],
      events: [], summary: 'Lumiere program applications close in October.', involvement: 'observer', activity: null,
    });
  }) as typeof sdk.queryLLM;
  return { db, sdk, org, program, calls: () => calls, prompts };
}

it('links registry entities, dates deadlines, and keeps quotes exact without a model', () => {
  const { sdk, org, program } = fixture();
  const source = sdk.database.query<any, []>("SELECT id AS source_id,title,type,uri,origin,created_at,updated_at FROM sources WHERE id='mail'").get();
  const result = deterministicExtraction(sdk, source, [{ chunk_index: 0, text_content: TEXT }]);
  expect(result.linked.sort()).toEqual([org.id, program.id].sort());
  const deadline = result.claims.find(claim => claim.predicate === 'HAS_DEADLINE')!;
  expect(deadline).toMatchObject({ value: '2026-10-16T04:59Z', method: 'temporal', subject: `g${program.id}` });
  expect(TEXT.includes(deadline.evidence[0]!.quote)).toBe(true);
  for (const entity of result.entities) for (const mention of entity.mentions ?? []) expect(TEXT.includes(mention.quote)).toBe(true);
  expect(result.unresolved).toContain('Priya');
  expect(result.complete).toBe(false);
  expect(extractiveSummary([{ chunk_index: 0, text_content: 'From: a@b.c\nThe program is run by Northbridge Labs. It closes in two weeks.' }]))
    .toBe('The program is run by Northbridge Labs. It closes in two weeks.');
});

it('decides involvement from recorded participants, and leaves email recipients to the model', () => {
  const chat = { origin: 'discord', type: 'chat_session' };
  expect(structuralInvolvement(chat, [{ self: true, position: 0 }, { self: false, position: 1 }], 7)).toBe('author');
  expect(structuralInvolvement(chat, [{ self: false, position: 0 }, { self: true, position: 3 }], 7)).toBe('participant');
  expect(structuralInvolvement(chat, [{ self: false, position: 0 }], 7)).toBe('observer');
  expect(structuralInvolvement({ origin: 'email', type: 'chat_session' }, [{ self: false, position: 0 }], 7)).toBeUndefined();
  // Entities a previous digest linked (no recorded position) are not connector evidence.
  expect(structuralInvolvement(chat, [{ self: true }], 7)).toBeUndefined();
  expect(structuralInvolvement({ origin: 'test', type: 'note' }, [{ self: true, position: 0 }], 7)).toBeUndefined();
});

it('shadow mode records the deterministic verdict and attaches the model verdict without changing the graph path', async () => {
  const { db, sdk, program } = fixture();
  expect((await run(sdk)).committed).toBe(1);
  const revision = db.query<{ id: number }, []>('SELECT id FROM graph_source_revisions').get()!.id;
  const row = db.query<{ verdict_json: string; llm_verdict_json: string; method: string }, [string]>(
    "SELECT verdict_json,llm_verdict_json,method FROM graph_shadow_decisions WHERE kind='extraction' AND subject_key=?").get(String(revision))!;
  expect(row.method).toBe('deterministic-extraction');
  const verdict = JSON.parse(row.verdict_json), llm = JSON.parse(row.llm_verdict_json);
  expect(verdict.entities).toContain(program.id);
  expect(verdict.temporal.some((item: { kind: string }) => item.kind === 'deadline')).toBe(true);
  expect(llm.involvement).toBe('observer');
  expect(llm.entities.length).toBeGreaterThan(0);
  // No deterministic records in shadow mode; model claims carry typed predicates and keep their wording.
  expect(sdk.graph.claims.list().some(claim => claim.method === 'gazetteer' || claim.method === 'temporal')).toBe(false);
  const offered = sdk.graph.claims.list({ predicate: 'OFFERED_BY' })[0]!;
  expect(offered.qualifiers).toMatchObject({ rawPredicate: 'is_offered_by' });
  // The model's timestamp is supported by the tagger reading the quote.
  expect(sdk.graph.claims.list({ predicate: 'HAS_DEADLINE' })[0]).toMatchObject({ validTo: Date.parse('2026-10-16T04:59:00Z'), qualifiers: { rawPredicate: 'closes' } });
});

it('active mode merges gazetteer links and dated claims, lists linked entities to the model, and recovers from checkpoints', async () => {
  const { sdk, org, program, prompts } = fixture({ deterministicMode: 'active' });
  const add = sdk.graph.claims.add.bind(sdk.graph.claims);
  sdk.graph.claims.add = () => { throw Error('Storage interrupted'); };
  await expect(run(sdk)).rejects.toThrow('Storage interrupted');
  sdk.graph.claims.add = add;
  expect(prompts[0]).toContain(`${program.id}: Lumiere Research Scholar Program [Opportunity]`);
  expect(prompts[0]).toContain('HAS_DEADLINE (');
  expect((await recover(sdk)).committed).toBe(1);
  const sources = sdk.database.query<{ entity_id: number }, []>("SELECT entity_id FROM source_entities WHERE source_id='mail'").all().map(row => row.entity_id);
  expect(sources).toContain(program.id);
  expect(sources).toContain(org.id);
  const temporal = sdk.graph.claims.list({ predicate: 'HAS_DEADLINE' }).find(claim => claim.method === 'temporal')!;
  expect(temporal).toMatchObject({ subject: program.id, value: '2026-10-16T04:59Z', model: undefined });
  expect(sdk.graph.evidence.list(temporal.id)[0]).toMatchObject({ method: 'temporal', quote: TEXT.slice(TEXT.indexOf('Lumiere'), TEXT.indexOf('EST.') + 4) });
  // The gazetteer's quote is the chunk-level evidence for the registry entity.
  expect(sdk.database.query<{ n: number }, [number]>('SELECT count(*) AS n FROM chunk_entities WHERE entity_id=?').get(program.id)!.n).toBeGreaterThan(0);
  // The model's registry match agreed with the gazetteer: committed as the registry entity itself.
  expect(sdk.graph.entities.resolve('Northbridge Labs')).toHaveLength(1);
});

it('skips the model for fully covered windows when allowed, with an extractive summary and structural involvement', async () => {
  const { db, sdk, program, calls } = fixture({ deterministicMode: 'active', skipLlmWhenCovered: true });
  const self = sdk.graph.entities.create({ stableId: SELF_STABLE_ID, name: 'Me', type: 'Person' });
  const session = sdk.graph.entities.create({ name: 'window', type: 'ChatSession' });
  sdk.ingest.sourceAndChunks({ source: { id: 'chat', uri: 'discord://x', title: 'Chat', origin: 'discord', type: 'chat_session', hash: 'c1',
    created_at: Date.parse('2026-10-01T00:00:00Z'), updated_at: Date.parse('2026-10-01T00:00:00Z') },
    chunks: [{ text_content: 'The Lumiere Research Scholar Program deadline is tomorrow, see the Northbridge Labs page for details.' }] });
  const event = sdk.graph.events.create({ name: 'chat', kind: 'conversation', participants: [{ entity: session.id, role: 'record' }, { entity: self.id, role: 'participant', position: 0 }] });
  db.query("INSERT INTO source_entities(source_id,entity_id) VALUES('chat',?)").run(event.entity.id);
  await run(sdk, { sourceIds: ['chat'] });
  expect(calls()).toBe(0);
  const digest = db.query<{ summary: string; involvement: string; model: string | null }, []>("SELECT summary,involvement,model FROM graph_source_digests WHERE source_id='chat'").get()!;
  expect(digest).toMatchObject({ involvement: 'author', model: null });
  expect(digest.summary).toContain('Lumiere Research Scholar Program deadline is tomorrow');
  expect(sdk.graph.claims.list({ predicate: 'HAS_DEADLINE' }).find(claim => claim.subject === program.id)).toMatchObject({ value: '2026-10-02', method: 'temporal' });
  // The other source still has an unknown name ("Priya"), so it goes to the model.
  await run(sdk, { sourceIds: ['mail'] });
  expect(calls()).toBe(1);
});

it('mergeDeterministic maps deterministic claims onto the model entity for the same thing', () => {
  const merged = mergeDeterministic({ entities: [{ key: 'p', name: 'Program', type: 'Opportunity', match: 5 }], claims: [], events: [] }, {
    entities: [{ key: 'g5', name: 'Program', type: 'Opportunity', entityId: 5, method: 'gazetteer', mentions: [{ chunkIndex: 0, quote: 'Program' }] },
      { key: 'm:Course:cs 136', name: 'CS 136', type: 'Course', method: 'pattern', mentions: [{ chunkIndex: 0, quote: 'CS 136' }] }],
    claims: [{ subject: 'g5', predicate: 'HAS_DEADLINE', value: '2026-10-15', method: 'temporal', evidence: [{ chunkIndex: 0, quote: 'x' }] }],
    temporal: [], linked: [5], unresolved: [], complete: true });
  expect(merged.entities.map(entity => [entity.key, entity.entityId])).toEqual([['p', 5], ['m:Course:cs 136', undefined]]);
  expect(merged.claims[0]!.subject).toBe('p');
});
