import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExtensionSDK } from '../sdk';
import { dropWords, duplicateRate, knownItemQueries, mulberry32, ndcg, nearDuplicates, normaliseTitle, percentile, recall, reciprocalRank,
  summarise, threadKey, threadQuery, typo, type Judgments } from '../scripts/eval/search';
import { createTestDatabase } from './fixtures/database';

const judged = (entries: Array<[string, number]>): Judgments => new Map(entries);

it('computes MRR, nDCG with graded gains, and recall', () => {
  const j = judged([['a', 3], ['b', 2], ['c', 1]]);
  expect(reciprocalRank(['x', 'c', 'b'], j)).toBe(1 / 3);
  expect(reciprocalRank(['x', 'y'], j)).toBe(0);
  expect(ndcg(['a', 'b', 'c'], j, 5)).toBeCloseTo(1);
  // Swapping the best two: (3/1 + 7/log2 3 + 1/2) / (7 + 3/log2 3 + 1/2).
  expect(ndcg(['b', 'a', 'c'], j, 5)).toBeCloseTo((3 + 7 / Math.log2(3) + 0.5) / (7 + 3 / Math.log2(3) + 0.5));
  expect(ndcg(['a', 'a'], judged([['a', 3]]), 5)).toBeCloseTo(1);
  expect(ndcg(['a'], judged([['z', 0]]), 5)).toBeNull();
  expect(recall(['a', 'x', 'c'], j, 50)).toBeCloseTo(2 / 3);
  expect(recall(['a', 'x', 'c'], j, 1)).toBeCloseTo(1 / 3);
});

it('counts near-duplicate pairs in the top five and nearest-rank percentiles', () => {
  const keys: Record<string, string[]> = { a: ['thread:1'], b: ['thread:1'], c: ['title:x'], d: ['title:x'], e: [] };
  expect(duplicateRate(['a', 'b', 'c', 'd', 'e'], id => keys[id] ?? [])).toBeCloseTo(2 / 10);
  expect(duplicateRate(['a'], id => keys[id] ?? [])).toBeNull();
  expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
  expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  expect(percentile([], 50)).toBeNull();
});

it('normalises titles, threads, and generated query variants deterministically', () => {
  expect(threadKey('email://inbox/thread/abc123#window=x')).toBe('abc123');
  expect(threadKey('https://example.com')).toBeNull();
  expect(normaliseTitle('Re: Fwd: Missing I-20 Documents!')).toBe('missing i 20 documents');
  expect(threadQuery('CCIR 1-on-1 research mentorship (2025)')).toBe('CCIR 1-on-1 research mentorship');
  expect(threadQuery('Hack the North 2026')).toBe('Hack the North');
  const word = typo('waterloo', mulberry32(3));
  expect(word).not.toBe('waterloo');
  expect(word[0]).toBe('w'); expect(word.at(-1)).toBe('o');
  expect(Math.abs(word.length - 8)).toBeLessThanOrEqual(1);
  expect(dropWords('Waterloo offer acceptance deadline reminder · 2026-05-28', mulberry32(1))!.split(' ').length).toBe(4);
  expect(dropWords('screenshot.png', mulberry32(1))).toBeNull();
  expect(typo('waterloo', mulberry32(3))).toBe(word);
});

function fixture() {
  const db = createTestDatabase();
  const sdk = createExtensionSDK('search-eval-test', { database: db });
  const add = (id: string, title: string, uri: string, text: string) => sdk.ingest.sourceAndChunks({
    source: { id, title, origin: 'email', type: 'chat_session', uri }, chunks: [{ text_content: text }] });
  add('a', 'Missing documents for visa · 2026-05-01', 'email://inbox/thread/t1#window=1', 'Admissions asked for the bank statement and passport copy for the visa certificate.');
  add('b', 'Missing documents for visa · 2026-05-08', 'email://inbox/thread/t1#window=2', 'Second reminder about the passport copy and sponsorship letter for the visa certificate.');
  add('c', 'Robotics club meeting notes', 'note://c', 'The robotics club discussed servo calibration and the gearbox redesign for the competition.');
  return db;
}

it('builds known-item queries whose judgments include thread siblings', () => {
  const db = fixture();
  try {
    const duplicates = nearDuplicates(db);
    expect(duplicates.siblings('a')).toEqual(['b']);
    const queries = knownItemQueries(db, { sample: 10, seed: 7, duplicates });
    expect(queries.length).toBeGreaterThan(0);
    expect(new Set(queries.map(q => q.kind))).toContain('rare-terms');
    const forA = queries.find(q => q.judgments.get('a') === 3)!;
    expect(forA.judgments.get('b')).toBe(2);
    expect(knownItemQueries(db, { sample: 10, seed: 7, duplicates }).map(q => q.query)).toEqual(queries.map(q => q.query));
    const s = summarise([{ set: 'known', kind: 'x', query: 'q', ranked: ['a'], relevant: 1, rr: 1, ndcg5: 1, ndcg10: 1, recall50: 1, dup5: null, ms: 4 }]);
    expect(s).toMatchObject({ queries: 1, judged: 1, mrr: 1, p95ms: 4 });
  } finally { db.close(); }
});

it('runs the CLI read-only against a database with the bm25 ranker', () => {
  const directory = mkdtempSync(join(tmpdir(), 'shale-search-eval-'));
  const path = join(directory, 'search.db'), judgedPath = join(directory, 'judged.json');
  const db = fixture();
  try {
    db.run(`VACUUM INTO '${path}'`);
    writeFileSync(judgedPath, JSON.stringify({ queries: [{ query: 'robotics gearbox', judgments: [{ sourceId: 'c', rel: 3 }] }] }));
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, '../scripts/search-eval.ts'), path, '--set', 'judged', '--judged', judgedPath, '--json']);
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout.toString());
    expect(report.summary.judged).toMatchObject({ queries: 1, judged: 1, mrr: 1, ndcg5: 1 });
    expect(report.queries[0].top[0]).toBe('c');
    const engine = Bun.spawnSync([process.execPath, join(import.meta.dir, '../scripts/search-eval.ts'), path, '--ranker', join(directory, 'missing.ts'), '--json']);
    expect(engine.exitCode).toBe(0);
    expect(JSON.parse(engine.stdout.toString()).skipped).toContain('not found');
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
