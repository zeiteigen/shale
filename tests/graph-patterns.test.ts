import { afterEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createExtensionSDK } from '../sdk';
import { createTestDatabase } from './fixtures/database';
import { addKnown, applyPatterns, contextOf, learnPatterns, patternTokens, refreshPatterns, seedsFromDatabase, storedPatterns,
  type KnownRelations, type PatternSeed } from '../lib/graph/patterns';
import { patternCandidates } from '../extensions/knowledge-graph/reason';

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

/** A seed whose subject and object spans are located by name in the text. */
function seed(index: number, predicate: string, text: string, subject: [number, string, string], object: [number, string, string]): PatternSeed {
  const s = text.indexOf(subject[1]), o = text.indexOf(object[1], s >= 0 && text.indexOf(object[1]) === s ? s + 1 : 0);
  return { claimId: `c${index}`, sourceId: `source-${index}`, revisionId: index, chunkIndex: 0, predicate, text,
    subject: subject[0], subjectType: subject[2], object: object[0], objectType: object[2],
    subjectSpan: [s, s + subject[1].length], objectSpan: [o, o + object[1].length] };
}

const people = ['Ada Byron', 'Grace Hopper', 'Alan Turing', 'Edsger Dijkstra', 'Barbara Liskov', 'Donald Knuth', 'Frances Allen', 'John Backus',
  'Leslie Lamport', 'Radia Perlman', 'Ken Thompson', 'Dennis Ritchie'];

describe('surface patterns', () => {
  it('normalises addresses, links, and numbers so templates share tokens', () => {
    expect(patternTokens('From: Ada <ada@example.com> on 12 May, see https://x.io/a').map(token => token.norm))
      .toEqual(['from', ':', 'ada', '<', '<email>', '>', 'on', '#', 'may', ',', 'see', '<url>']);
    const tokens = patternTokens('Ada Byron works at Acme Corp today');
    expect(contextOf(tokens, [0, 9], [19, 28])).toEqual({ order: 'so', left: [], middle: ['works', 'at'], right: ['today'] });
  });

  it('keeps patterns supported by distinct pairs and precise on held-out folds, and drops ambiguous ones', () => {
    const seeds: PatternSeed[] = [], known: KnownRelations = new Map();
    // "X <addr> To: Y" says SENT_TO for twelve different sender/recipient pairs.
    for (let i = 0; i < 12; i++) {
      const from = people[i]!, to = people[(i + 5) % 12]!;
      const text = `From: ${from} <s${i}@mail.example.org>\nTo: ${to} <r${i}@example.com>`;
      seeds.push(seed(i, 'SENT_TO', text, [i + 1, from, 'Person'], [((i + 5) % 12) + 1, to, 'Person']));
      addKnown(known, i + 1, 'SENT_TO', ((i + 5) % 12) + 1);
    }
    // "X and Y" is said of colleagues (WORKS_AT is wrong for half of them): the model related those pairs differently.
    for (let i = 0; i < 8; i++) {
      const person = people[i]!, org = `Org${i} Labs`;
      seeds.push(seed(100 + i, 'WORKS_AT', `${person} and ${org} announced`, [i + 1, person, 'Person'], [200 + i, org, 'Organization']));
      if (i % 2) addKnown(known, i + 1, 'WORKS_AT', 200 + i); else addKnown(known, i + 1, 'MENTIONS', 200 + i);
    }
    const learned = learnPatterns(seeds, known, { minSupport: 3, minEvaluated: 2 });
    expect(learned.patterns.length).toBeGreaterThan(0);
    expect(learned.patterns.every(pattern => pattern.predicate === 'SENT_TO' && pattern.precision >= 0.9 && pattern.support >= 3)).toBe(true);
    expect(learned.patterns.some(pattern => pattern.middle.join(' ') === '< <email> > to :')).toBe(true);
    expect(learned.heldOut.seedRecall).toBeGreaterThan(0.5);
  });

  it('applies patterns to gazetteer spans with exact quotes, checking domain and range', () => {
    const pattern = { id: 'pattern:test', predicate: 'SENT_TO', order: 'so' as const, left: [], middle: ['<', '<email>', '>', 'to', ':'], right: [],
      support: 5, precision: 1, evaluated: 8 };
    const text = 'Header\nFrom: Ada Byron <ada@example.org>\nTo: Grace Hopper <grace@example.com>\nBody';
    const mention = (entityId: number, name: string, type = 'Person') => ({ entityId, type, start: text.indexOf(name), end: text.indexOf(name) + name.length });
    const [candidate, ...rest] = applyPatterns(text, [mention(1, 'Ada Byron'), mention(2, 'Grace Hopper')], [pattern]);
    expect(rest).toEqual([]);
    expect(candidate).toMatchObject({ subject: 1, predicate: 'SENT_TO', object: 2, patternId: 'pattern:test' });
    expect(text.slice(candidate!.start, candidate!.end)).toBe(candidate!.quote);
    expect(candidate!.quote).toBe('Ada Byron <ada@example.org>\nTo: Grace Hopper');
    expect(candidate!.confidence).toBeCloseTo(0.9, 1);
    // A Concept cannot send mail: the schema's domain refuses the firing.
    expect(applyPatterns(text, [mention(1, 'Ada Byron', 'Concept'), mention(2, 'Grace Hopper')], [pattern])).toEqual([]);
  });

  it('seeds from model claims quoting both names, stores learned patterns, and fires them on digested sources', () => {
    const db = createTestDatabase(); databases.push(db);
    const sdk = createExtensionSDK('knowledge-graph', { database: db, namespace: 'knowledge' });
    const ids = people.map(name => sdk.graph.entities.create({ name, type: 'Person' }).id);
    for (let i = 0; i < 12; i++) {
      const from = people[i]!, to = people[(i + 5) % 12]!;
      const text = `From: ${from} <s${i}@mail.example.org>\nTo: ${to} <r${i}@example.com>\n\nHello there.`;
      sdk.ingest.sourceAndChunks({ source: { id: `mail-${i}`, uri: `mail://${i}`, title: `Mail ${i}`, origin: 'email', type: 'email', hash: `h${i}` },
        chunks: [{ text_content: text }] });
      const chunk = db.query<{ chunk_index: number; text_content: string }, [string]>(`SELECT p.chunk_index,p.text_content FROM graph_revision_chunks p
        JOIN graph_source_revisions r ON r.id=p.revision_id WHERE r.source_id=? AND p.text_content LIKE 'From:%'`).get(`mail-${i}`)!;
      const quote = chunk.text_content.slice(0, chunk.text_content.indexOf('\n\n'));
      sdk.graph.claims.add({ subject: ids[i]!, predicate: 'sent_email_to', object: ids[(i + 5) % 12]!, method: 'llm',
        evidence: [{ sourceId: `mail-${i}`, chunkIndex: chunk.chunk_index, quote }] });
    }
    const { seeds } = seedsFromDatabase(db);
    expect(seeds).toHaveLength(12);
    expect(seeds[0]).toMatchObject({ predicate: 'SENT_TO', subjectType: 'Person' });
    const { learned, relearned } = refreshPatterns(db, { minEvaluated: 1 });
    expect(relearned).toBe(true);
    expect(learned.patterns.length).toBeGreaterThan(0);
    expect(storedPatterns(db)?.patterns.length).toBe(learned.patterns.length);
    // Fresh state is reused until it is a day old and enough new claims arrived.
    expect(refreshPatterns(db).relearned).toBe(false);

    sdk.ingest.sourceAndChunks({ source: { id: 'mail-new', uri: 'mail://new', title: 'New', origin: 'email', type: 'email', hash: 'hn' },
      chunks: [{ text_content: 'From: Grace Hopper <grace@mail.example.org>\nTo: Alan Turing <alan@example.com>\n\nHi.' }] });
    for (const id of ids) db.query("INSERT INTO entity_registry_fts(rowid,text) VALUES(?, 'person')").run(id);
    const revision = db.query<{ id: number }, []>("SELECT id FROM graph_source_revisions WHERE source_id='mail-new'").get()!.id;
    const found = patternCandidates(db, 'mail-new', revision, learned.patterns);
    expect(found).toContainEqual(expect.objectContaining({ subject: ids[1], predicate: 'SENT_TO', object: ids[2], quote: 'Grace Hopper <grace@mail.example.org>\nTo: Alan Turing' }));
  });
});
