import type { Database } from 'bun:sqlite';
import { optionalExport, ratio } from './common';

/**
 * Identity-resolution replay: the decided pairs in graph_resolution_queue are labels, and a deterministic
 * scorer is judged on how many of them it could have decided alone, and how correctly.
 *
 * Scorer contract (phase P1's lib/graph/linkage.ts plugs in here, loaded dynamically; see loadIdentityScorer):
 *   export function createIdentityScorer(db: Database, train: IdentityLabel[]): IdentityScorer | Promise<IdentityScorer>
 *     fit on the older 80% of labels, return a scorer for the rest; or, without fitting,
 *   export function scoreIdentityPair(db: Database, mentionId: number, candidateId: number): number | null
 * lib/graph/linkage.ts as P1 shipped it exports trainFromDatabase(db, {pairs}) + createScorer(db, model), which is adapted.
 *   IdentityScorer = (db, mentionId, candidateId) => P(same) in [0,1], or null for "no opinion" (always deferred).
 * Bands: p >= hi decides "same", p <= lo decides "different", anything between goes to the model.
 */
export interface IdentityLabel {
  mentionId: number; candidateId: number; same: boolean; decidedAt: number; reason: string; basis: string;
  /** 'rule' for deterministic decisions ("same X name", linkage, cannot-link), 'model' for adjudicated verdicts. */
  decider: 'rule' | 'model'; type: string;
}
export type IdentityScorer = (db: Database, mentionId: number, candidateId: number) => number | null;
export type IdentityScorerFactory = (db: Database, train: IdentityLabel[]) => IdentityScorer | Promise<IdentityScorer>;

/** Reasons that are bookkeeping rather than a judgment about the pair. */
export const NON_JUDGMENTS = ['superseded by merge', 'already the same entity', 'different kinds of thing'];

export function identityLabels(db: Database, testFraction = 0.2): { all: IdentityLabel[]; train: IdentityLabel[]; test: IdentityLabel[] } {
  const rows = db.query<{ mention_id: number; candidate_id: number; state: string; decided_at: number | null; created_at: number; reason: string | null; basis: string; type: string | null }, string[]>(
    `SELECT q.mention_id,q.candidate_id,q.state,q.decided_at,q.created_at,q.reason,q.basis,e.type FROM graph_resolution_queue q
     LEFT JOIN entities e ON e.id=q.mention_id
     WHERE q.state IN ('same','different') AND coalesce(q.reason,'') NOT IN (${NON_JUDGMENTS.map(() => '?').join(',')})
     ORDER BY coalesce(q.decided_at,q.created_at),q.mention_id,q.candidate_id`).all(...NON_JUDGMENTS);
  const all = rows.map((row): IdentityLabel => ({ mentionId: row.mention_id, candidateId: row.candidate_id, same: row.state === 'same',
    decidedAt: row.decided_at ?? row.created_at, reason: row.reason ?? '', basis: row.basis, type: row.type ?? 'unknown',
    decider: /^(same \S+ name$|linkage|cannot-link)/.test(row.reason ?? '') ? 'rule' : 'model' }));
  return { all, ...splitByTime(all, testFraction) };
}

/** Older labels train, newer test: the scorer is judged on verdicts it could not have seen, as it would be live. */
export function splitByTime<T extends { decidedAt: number }>(labels: T[], testFraction = 0.2) {
  const sorted = [...labels].sort((a, b) => a.decidedAt - b.decidedAt);
  const cut = Math.round(sorted.length * (1 - testFraction));
  return { train: sorted.slice(0, cut), test: sorted.slice(cut) };
}

export interface Band { hi: number; lo: number }
export interface BandResult {
  band: Band; labels: number; decided: number; coverage: number | null; accuracy: number | null;
  same: { decided: number; correct: number; precision: number | null; recall: number | null };
  different: { decided: number; correct: number; precision: number | null; recall: number | null };
  /** Pairs the model would no longer see, and the adjudication requests that saves (it batches pairs). */
  llmPairsAvoided: number; llmRequestsAvoided: number; noOpinion: number;
}

/** Score once, then judge every band on the same scores (scoring may be expensive; bands are cheap). */
export function scoreLabels(db: Database, labels: IdentityLabel[], scorer: IdentityScorer) {
  return labels.map(label => ({ label, p: scorer(db, label.mentionId, label.candidateId) }));
}

export function evaluateBands(scored: { label: IdentityLabel; p: number | null }[], bands: Band[], pairsPerRequest = 8): BandResult[] {
  const totalSame = scored.filter(row => row.label.same).length, totalDifferent = scored.length - totalSame;
  return bands.map(band => {
    let sameDecided = 0, sameCorrect = 0, diffDecided = 0, diffCorrect = 0, noOpinion = 0;
    for (const { label, p } of scored) {
      if (p == null || Number.isNaN(p)) { noOpinion++; continue; }
      if (p >= band.hi) { sameDecided++; if (label.same) sameCorrect++; }
      else if (p <= band.lo) { diffDecided++; if (!label.same) diffCorrect++; }
    }
    const decided = sameDecided + diffDecided;
    return { band, labels: scored.length, decided, coverage: ratio(decided, scored.length), accuracy: ratio(sameCorrect + diffCorrect, decided),
      same: { decided: sameDecided, correct: sameCorrect, precision: ratio(sameCorrect, sameDecided), recall: ratio(sameCorrect, totalSame) },
      different: { decided: diffDecided, correct: diffCorrect, precision: ratio(diffCorrect, diffDecided), recall: ratio(diffCorrect, totalDifferent) },
      llmPairsAvoided: decided, llmRequestsAvoided: Math.floor(decided / pairsPerRequest), noOpinion };
  });
}

/** Wrong automatic decisions at one band, named, so a reviewer can see what kind of pair the scorer gets wrong. */
export function bandErrors(db: Database, scored: { label: IdentityLabel; p: number | null }[], band: Band, limit = 10) {
  const name = db.query<{ name: string }, [number]>('SELECT coalesce(display_name,name) AS name FROM entities WHERE id=?');
  return scored.filter(({ label, p }) => p != null && (p >= band.hi ? !label.same : p <= band.lo ? label.same : false))
    .sort((a, b) => Math.abs(b.p! - 0.5) - Math.abs(a.p! - 0.5)).slice(0, limit)
    .map(({ label, p }) => ({ p: Number(p!.toFixed(3)), label: label.same ? 'same' : 'different', type: label.type,
      mention: name.get(label.mentionId)?.name ?? label.mentionId, candidate: name.get(label.candidateId)?.name ?? label.candidateId, reason: label.reason }));
}

/** The plan's promotion gate for identity: auto-merge ("same") precision of at least 0.98 at the band. */
export const IDENTITY_GATE = 0.98;
export const meetsIdentityGate = (result: BandResult) => result.same.decided > 0 && (result.same.precision ?? 0) >= IDENTITY_GATE;

export const DEFAULT_BANDS: Band[] = [{ hi: 0.97, lo: 0.03 }, { hi: 0.95, lo: 0.05 }, { hi: 0.9, lo: 0.1 }];
export const parseBands = (text: string): Band[] => text.split(',').map(part => {
  const [hi, lo] = part.split(':').map(Number);
  if (!(hi! >= 0 && hi! <= 1 && lo! >= 0 && lo! <= hi!)) throw new Error(`bad band "${part}" (expected hi:lo, e.g. 0.97:0.03)`);
  return { hi: hi!, lo: lo! };
});

/**
 * A floor any learned model must beat: same normalised name and type is "same", anything else no opinion.
 * It reproduces what EXACT_NAME_TYPES-style rules decide, applied to every type.
 */
export function exactNameBaseline(db: Database): IdentityScorer {
  const query = db.query<{ name: string; display: string | null; type: string }, [number]>('SELECT name,display_name AS display,type FROM entities WHERE id=?');
  const norm = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return (_db, a, b) => {
    const x = query.get(a), y = query.get(b);
    if (!x || !y) return null;
    const nx = norm(x.display ?? x.name), ny = norm(y.display ?? y.name);
    return x.type === y.type && nx && nx === ny ? 0.99 : null;
  };
}

/**
 * P1's scorer when it exists. In order of preference: a factory fitted on the training split; lib/graph/linkage.ts's
 * own `trainFromDatabase` + `createScorer`, refit here on the model-decided training labels only (so test verdicts
 * stay unseen, apart from whatever its shipped prior weights were fitted on); then any unfitted pair scorer.
 */
export async function loadIdentityScorer(db: Database, train: IdentityLabel[], modulePath?: string): Promise<{ scorer: IdentityScorer; from: string } | { skipped: string }> {
  const paths = modulePath ? [modulePath] : ['lib/graph/linkage.ts'];
  const factory = await optionalExport<IdentityScorerFactory>(paths, ['createIdentityScorer']);
  if ('value' in factory) return { scorer: await factory.value(db, train), from: `${factory.path}#${factory.name}` };
  type Fit = (db: Database, options: { pairs: { mention: number; candidate: number; label: 0 | 1; decidedAt: number; type: string }[] }) => unknown;
  const fit = await optionalExport<Fit>(paths, ['trainFromDatabase']), create = await optionalExport<(db: Database, model?: unknown) => IdentityScorer>(paths, ['createScorer']);
  if ('value' in create) {
    if ('value' in fit) {
      const pairs = train.filter(label => label.decider === 'model').map(label => ({ mention: label.mentionId, candidate: label.candidateId,
        label: (label.same ? 1 : 0) as 0 | 1, decidedAt: label.decidedAt, type: label.type }));
      return { scorer: create.value(db, fit.value(db, { pairs })), from: `${create.path}#trainFromDatabase(train split)+createScorer` };
    }
    return { scorer: create.value(db), from: `${create.path}#createScorer` };
  }
  const direct = await optionalExport<IdentityScorer>(paths, ['scoreIdentityPair', 'linkageProbability', 'scorePair']);
  if ('value' in direct) return { scorer: direct.value, from: `${direct.path}#${direct.name}` };
  return { skipped: factory.skipped };
}
