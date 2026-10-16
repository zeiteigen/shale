import { afterEach, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase } from './fixtures/database';
import { ensureStorySchema } from '../lib/graph/story-schema';
import { recordShadow } from '../lib/graph/shadow';
import { clusterAgreement, clusterStats } from '../scripts/eval/clustering';
import { evaluateBands, identityLabels, parseBands, splitByTime, type IdentityLabel } from '../scripts/eval/identity';
import { COMPARATORS, decisionOf, genericComparator, shadowAgreement } from '../scripts/eval/shadow';
import { mappingCoverage } from '../scripts/eval/predicates';
import { scoreExtraction } from '../scripts/eval/extraction';
import { referenceMembership } from '../scripts/eval/episodes';
import { canonicalRoots } from '../scripts/eval/common';

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const fixture = () => { const db = createTestDatabase(); databases.push(db); ensureStorySchema(db); return db; };
const entity = (db: Database, name: string, type = 'Person', canonical: number | null = null) =>
  Number(db.query("INSERT INTO entities(namespace,name,type,canonical_id) VALUES('knowledge',?,?,?)").run(name, type, canonical).lastInsertRowid);

it('scores pairwise and B-cubed agreement from the contingency table', () => {
  const reference = new Map<string, string>([['a', 'X'], ['b', 'X'], ['c', 'X'], ['d', 'Y'], ['e', 'Y']]);
  expect(clusterAgreement(reference, reference)).toMatchObject({ pairwise: { precision: 1, recall: 1, f1: 1 }, bcubed: { precision: 1, recall: 1, f1: 1 } });
  // Candidate splits X into {a,b} and {c}, and wrongly joins c with d.
  const candidate = new Map<string, number>([['a', 1], ['b', 1], ['c', 2], ['d', 2], ['e', 3]]);
  const result = clusterAgreement(reference, candidate);
  expect(result.pairwise).toMatchObject({ truePairs: 1, referencePairs: 4, candidatePairs: 2, precision: 0.5, recall: 0.25 });
  expect(result.pairwise.f1).toBeCloseTo(1 / 3);
  // B-cubed precision: a,b 1; c,d 1/2; e 1 -> 4/5. Recall: a,b 2/3; c 1/3; d,e 1/2 -> (2/3+2/3+1/3+1/2+1/2)/5.
  expect(result.bcubed.precision).toBeCloseTo(0.8);
  expect(result.bcubed.recall).toBeCloseTo((2 / 3 + 2 / 3 + 1 / 3 + 0.5 + 0.5) / 5);
  // Items the candidate leaves out are singletons, never free agreement.
  const partial = clusterAgreement(reference, new Map([['a', 1], ['b', 1]]));
  expect(partial).toMatchObject({ candidateCovered: 2, pairwise: { truePairs: 1, candidatePairs: 1, precision: 1, recall: 0.25 } });
  expect(clusterStats(candidate)).toEqual({ items: 5, clusters: 3, singletons: 1, largest: 2, median: 2 });
});

it('splits identity labels by time and judges decision bands', () => {
  const db = fixture();
  const [a, b, c, d] = ['Ali', 'Ali M', 'Bob', 'Rob'].map(name => entity(db, name));
  const queue = db.query('INSERT INTO graph_resolution_queue(mention_id,candidate_id,basis,created_at,state,decided_at,reason) VALUES(?,?,?,?,?,?,?)');
  queue.run(a!, b!, 'key:name', 1, 'same', 10, 'Same person.');
  queue.run(c!, d!, 'key:name', 1, 'different', 20, 'Different people.');
  queue.run(a!, c!, 'key:name', 1, 'same', 30, 'same Person name');
  queue.run(b!, d!, 'key:name', 1, 'different', 40, 'superseded by merge');
  queue.run(b!, c!, 'key:name', 1, 'pending', null, null);
  const { all, train, test } = identityLabels(db, 1 / 3);
  expect(all.map(label => [label.decidedAt, label.same, label.decider])).toEqual([[10, true, 'model'], [20, false, 'model'], [30, true, 'rule']]);
  expect(train.map(label => label.decidedAt)).toEqual([10, 20]);
  expect(test.map(label => label.decidedAt)).toEqual([30]);
  expect(splitByTime([{ decidedAt: 3 }, { decidedAt: 1 }, { decidedAt: 2 }], 0.34).test).toEqual([{ decidedAt: 3 }]);

  const label = (same: boolean): IdentityLabel => ({ mentionId: 0, candidateId: 0, same, decidedAt: 0, reason: '', basis: '', decider: 'model', type: 'Person' });
  const scored = [{ label: label(true), p: 0.99 }, { label: label(false), p: 0.98 }, { label: label(true), p: 0.5 }, { label: label(false), p: 0.01 }, { label: label(true), p: null }];
  const [strict] = evaluateBands(scored, parseBands('0.97:0.03'), 2);
  expect(strict).toMatchObject({ labels: 5, decided: 3, accuracy: 2 / 3, noOpinion: 1, llmPairsAvoided: 3, llmRequestsAvoided: 1,
    same: { decided: 2, correct: 1, precision: 0.5, recall: 1 / 3 }, different: { decided: 1, correct: 1, precision: 1, recall: 0.5 } });
  expect(() => parseBands('0.2:0.9')).toThrow();
});

it('compares shadow verdicts per kind and counts rows without a model verdict', () => {
  expect(decisionOf({ verdict: 'same', confidence: 0.9 })).toBe('same');
  expect(decisionOf({ abstain: true })).toBeUndefined();
  expect(genericComparator({ tier: 'private' }, { tier: 'private', reason: 'x' })).toBe('agree');
  expect(genericComparator({ tier: 'personal' }, { tier: 'private' })).toBe('disagree');
  expect(genericComparator(null, { tier: 'private' })).toBe('abstain');
  expect(genericComparator({ a: 1, b: [2] }, { b: [2], a: 1 })).toBe('agree');
  expect(COMPARATORS.identity!({ same: true }, { verdict: 'same' })).toBe('agree');
  expect(COMPARATORS.identity!({ verdict: 'unsure' }, { verdict: 'same' })).toBe('abstain');
  expect(COMPARATORS.episode!({ episode: null }, { episode: null })).toBe('agree');
  expect(COMPARATORS.episode!({ episode: 12 }, { episode: '12' })).toBe('agree');

  const db = fixture();
  recordShadow(db, { kind: 'identity', subject: '1:2', method: 'linkage', verdict: { same: true }, llm: { verdict: 'same' } });
  recordShadow(db, { kind: 'identity', subject: '1:3', method: 'linkage', verdict: { same: false }, llm: { verdict: 'same' } });
  recordShadow(db, { kind: 'identity', subject: '1:4', method: 'linkage', verdict: null, llm: { verdict: 'same' } });
  recordShadow(db, { kind: 'identity', subject: '1:5', method: 'linkage', verdict: { same: true } });
  recordShadow(db, { kind: 'access', subject: 'source:x', method: 'bayes', verdict: { tier: 'private' }, llm: { tier: 'private' } });
  expect(shadowAgreement(db)).toEqual([
    { kind: 'access', method: 'bayes', total: 1, withLlm: 1, abstained: 0, agree: 1, disagree: 0, agreement: 1, coverage: 1 },
    { kind: 'identity', method: 'linkage', total: 4, withLlm: 3, abstained: 1, agree: 1, disagree: 1, agreement: 0.5, coverage: 2 / 3 },
  ]);
});

it('measures predicate mapping coverage and extraction recall over canonical ids', () => {
  const rows = [{ predicate: 'works at', n: 5 }, { predicate: 'WORKS_AT', n: 3 }, { predicate: 'likes', n: 2 }];
  const coverage = mappingCoverage(rows, predicate => /work/i.test(predicate) ? 'WORKS_AT' : 'RELATED_TO');
  expect(coverage).toMatchObject({ distinct: 3, mapped: 2, mappedClaims: 8, claims: 10, distinctCoverage: 2 / 3, claimCoverage: 0.8, targets: 1 });
  expect(coverage.topUnmapped).toEqual([{ predicate: 'likes', n: 2 }]);

  const db = fixture();
  const root = entity(db, 'Waterloo', 'Organization'), alias = entity(db, 'UWaterloo', 'Organization', root), other = entity(db, 'TD', 'Organization');
  const canonical = canonicalRoots(db);
  expect(canonical(alias)).toBe(root);
  const reference = new Map([['s1', new Set([root, other])], ['s2', new Set([other])]]);
  expect(scoreExtraction(reference, new Map([['s1', [alias, 999]]]), canonical)).toEqual({ sources: 2, reference: 3, predicted: 2, hits: 1,
    microRecall: 1 / 3, microPrecision: 0.5, macroRecall: 0.25, fullRecallSources: 0 });
});

it('reads reference episode membership through merged episodes', () => {
  const db = fixture();
  const subject = entity(db, 'source', 'Source'), kept = entity(db, 'episode:a', 'Episode'), merged = entity(db, 'episode:b', 'Episode', kept);
  const claim = db.query(`INSERT INTO graph_claims(id,namespace,subject_id,predicate,object_id,qualifiers,observed_at,recorded_at,confidence,method,status)
    VALUES(?,'episodes',?,'PART_OF_EPISODE',?,?,1,1,?,'episode-assignment',?)`);
  claim.run('c1', subject, kept, JSON.stringify({ sourceId: 's1' }), 0.9, 'accepted');
  claim.run('c2', subject, merged, JSON.stringify({ sourceId: 's2' }), 0.9, 'accepted');
  claim.run('c3', subject, kept, JSON.stringify({ sourceId: 's3' }), 0.9, 'retracted');
  const { assignment, multi } = referenceMembership(db);
  expect([...assignment]).toEqual([['s1', kept], ['s2', kept]]);
  expect(multi).toBe(0);
});

it('runs every section read-only against a fresh database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'shale-llm-eval-'));
  try {
    const path = join(directory, 'graph.db');
    const db = createTestDatabase(path); ensureStorySchema(db); db.close();
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, '../scripts/llm-replacement-eval.ts'), path, '--json']);
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout.toString());
    expect(Object.keys(report)).toEqual(['database', 'identity', 'episodes', 'extraction', 'predicates', 'shadow']);
    expect(report.identity.labels.all.labels).toBe(0);
    expect(report.predicates).toMatchObject({ claims: 0, distinct: 0 });
    expect(report.shadow.rows).toEqual([]);
    const text = Bun.spawnSync([process.execPath, join(import.meta.dir, '../scripts/llm-replacement-eval.ts'), path, '--section', 'shadow']);
    expect(text.exitCode).toBe(0);
    expect(text.stdout.toString()).toContain('none recorded yet');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
