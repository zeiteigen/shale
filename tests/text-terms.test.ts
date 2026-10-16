import { describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createTestDatabase } from './fixtures/database';
import { buildPhraseDictionary, loadPhraseDictionary, refreshPhraseDictionary, sourceKeyphrases, termStatistics, termFragments } from '../lib/text/terms';
import { queryTerms } from '../sdk/graph/registry';

let next = 0;
function addSource(db: Database, title: string, body: string, origin = 'obsidian', uri = `note://${next}`) {
  const id = `s${++next}`;
  db.query('INSERT INTO sources(id,type,uri,origin,created_at,title,updated_at,hash) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, 'markdown_note', uri, origin, next, title, next, `h${next}`);
  db.query("INSERT INTO chunks(source_id,chunk_index,text_content,chunk_type) VALUES(?,?,?,'verbatim')").run(id, 1, body);
  return id;
}

const FILLER = ['gardening tips for spring', 'tomato seedlings need light', 'compost bins and worms', 'pruning roses in march',
  'watering schedules for lawns', 'mulch keeps moisture', 'herb planters on balconies', 'soil acidity matters'];

/** A corpus where "machine learning" is a real term, "the" is noise, and one sender repeats a footer word. */
function corpus() {
  const db = createTestDatabase();
  for (let i = 0; i < 60; i++) addSource(db, `Garden note ${i}`, `${FILLER[i % FILLER.length]}. The garden grows. ${FILLER[(i + 3) % FILLER.length]}.`);
  for (let i = 0; i < 6; i++) addSource(db, `ML note ${i}`, `Machine learning models. We studied machine learning with gradient descent. Notes on machine learning.`);
  for (let i = 0; i < 8; i++) addSource(db, `Newsletter ${i}`, `[09:00] Acme <news@acme.example>: Acme weekly roundup.\nTopic ${['volcanoes', 'glaciers', 'tides', 'comets', 'deserts', 'reefs', 'auroras', 'canyons'][i]} explained in depth.\nAcme weekly roundup brought to you by Acme.`,
    'email', `email://inbox/${i}`);
  return db;
}

describe('phrase dictionary', () => {
  it('splits at punctuation and drops metadata, speakers, and links', () => {
    const fragments = termFragments('From: a@b.c\n[10:00] Bob: Machine learning, mostly. See https://x.y/z now').map(f => f.map(t => t.key).join(' '));
    expect(fragments).toEqual(['machine learning', 'mostly', 'see now']);
  });

  it('keeps multiword terms with df ≥ 2 and scores termhood', () => {
    const db = corpus();
    const build = buildPhraseDictionary(db);
    expect(build.documents).toBe(74);
    const dictionary = loadPhraseDictionary(db);
    expect(dictionary.documents).toBe(74);
    const ml = dictionary.get('Machine Learning')!;
    expect(ml.df).toBe(6);
    expect(ml.cValue).toBeGreaterThan(3);
    expect(ml.g2).toBeGreaterThan(10.83);
    expect(dictionary.has('learning models we')).toBe(false);
    expect(termStatistics(db).df('garden')).toBe(60);
  });

  it('refreshes only when the corpus changed, and the cached dictionary follows', () => {
    const db = corpus();
    expect(refreshPhraseDictionary(db)).toBe(74);
    expect(refreshPhraseDictionary(db)).toBe(0);
    const before = loadPhraseDictionary(db);
    expect(loadPhraseDictionary(db)).toBe(before);
    addSource(db, 'Quantum note', 'Quantum annealing. Quantum annealing again.');
    addSource(db, 'Quantum note 2', 'Quantum annealing hardware.');
    expect(refreshPhraseDictionary(db)).toBe(76);
    expect(loadPhraseDictionary(db).has('quantum annealing')).toBe(true);
    expect(refreshPhraseDictionary(db, { force: true })).toBe(76);
  });

  it('reads as empty, not an error, without tables', () => {
    const db = createTestDatabase();
    expect(loadPhraseDictionary(db).documents).toBe(0);
    expect(sourceKeyphrases(db, 'x', 'Machine learning with gradient descent.').length).toBeGreaterThan(0);
  });
});

describe('sourceKeyphrases', () => {
  it('prefers informative corpus terms and is deterministic', () => {
    const db = corpus();
    buildPhraseDictionary(db);
    const id = addSource(db, 'Study log', 'Machine learning homework. The garden grows. Machine learning exam on gradient descent.');
    const phrases = sourceKeyphrases(db, id, 'Study log\nMachine learning homework. The garden grows. Machine learning exam on gradient descent.');
    expect(phrases[0]!.phrase).toBe('Machine learning');
    expect(phrases.map(p => p.phrase)).not.toContain('garden');
    // Stem-sharing duplicates collapse to one phrase.
    expect(phrases.filter(p => /learning/i.test(p.phrase))).toHaveLength(1);
    expect(sourceKeyphrases(db, id, 'Study log\nMachine learning homework. Machine learning exam on gradient descent.'))
      .toEqual(sourceKeyphrases(db, id, 'Study log\nMachine learning homework. Machine learning exam on gradient descent.'));
  });

  it("suppresses a sender's routine words against its own background", () => {
    const db = corpus();
    buildPhraseDictionary(db);
    const id = addSource(db, 'Newsletter 9', '[09:00] Acme <news@acme.example>: Acme weekly roundup.\nTopic geysers explained in depth.\nAcme weekly roundup brought to you by Acme.', 'email', 'email://inbox/9');
    const text = 'Newsletter 9\n[09:00] Acme <news@acme.example>: Acme weekly roundup.\nTopic geysers explained in depth.\nAcme weekly roundup brought to you by Acme.';
    const contrasted = sourceKeyphrases(db, id, text, { contrast: 1 }).map(p => p.phrase.toLowerCase());
    expect(contrasted[0]).toBe('geysers');
    const plain = sourceKeyphrases(db, id, text, { contrast: 0 });
    const contrastedScores = sourceKeyphrases(db, id, text, { contrast: 1 });
    const acme = (list: typeof plain) => list.find(p => /acme/i.test(p.phrase))?.score ?? 0;
    expect(acme(contrastedScores)).toBeLessThan(acme(plain));
  });

  it('excludes words the caller names', () => {
    const db = corpus();
    buildPhraseDictionary(db);
    expect(sourceKeyphrases(db, '', 'Alice discussed compost bins. Alice likes compost.', { exclude: ['alice'] }).map(p => p.phrase.toLowerCase()))
      .not.toContain('alice');
  });
});

describe('queryTerms', () => {
  it('ranks by corpus IDF when statistics exist, by capitalisation otherwise', () => {
    const db = corpus();
    expect(queryTerms(['Garden volcanoes'], 2)).toEqual(['garden', 'volcanoes']);
    buildPhraseDictionary(db);
    expect(queryTerms(['Garden volcanoes'], 2, db)).toEqual(['volcanoes', 'garden']);
  });
});
