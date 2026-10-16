import type { Database } from 'bun:sqlite';
import { hasTable, ratio } from './common';

/**
 * Agreement between deterministic verdicts and the model's, from graph_shadow_decisions (lib/graph/shadow.ts).
 * Verdicts are free-form JSON; a per-kind comparator reads the decision out of each. The generic one looks for
 * the first of {verdict, same, episode, tier, label, value} and otherwise compares the whole JSON.
 * A null/absent verdict, or {abstain: true}, means the deterministic side deferred: it counts toward
 * coverage, never toward agreement.
 */
export type Outcome = 'agree' | 'disagree' | 'abstain';
export type Comparator = (deterministic: unknown, llm: unknown) => Outcome;

const DECISION_KEYS = ['verdict', 'same', 'episode', 'tier', 'label', 'value'] as const;
const canonicalJson = (value: unknown): string => value === null || typeof value !== 'object' ? JSON.stringify(value ?? null)
  : Array.isArray(value) ? `[${value.map(canonicalJson).join(',')}]`
  : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;

/** The decision inside a verdict, or undefined when it abstained. */
export function decisionOf(verdict: unknown): unknown {
  if (verdict === null || verdict === undefined) return undefined;
  if (typeof verdict !== 'object' || Array.isArray(verdict)) return verdict;
  const record = verdict as Record<string, unknown>;
  if (record.abstain === true) return undefined;
  for (const key of DECISION_KEYS) if (key in record) return record[key];
  return verdict;
}

export const genericComparator: Comparator = (deterministic, llm) => {
  const a = decisionOf(deterministic), b = decisionOf(llm);
  if (a === undefined || a === null) return 'abstain';
  return canonicalJson(a) === canonicalJson(b) ? 'agree' : 'disagree';
};

/** same/different verdicts may be booleans ({same}) or words ({verdict:'same'}); normalise before comparing. */
const identityDecision = (verdict: unknown) => {
  const decision = decisionOf(verdict);
  if (decision === true || decision === 'same') return 'same';
  if (decision === false || decision === 'different') return 'different';
  return decision;
};
export const COMPARATORS: Partial<Record<string, Comparator>> = {
  identity: (deterministic, llm) => {
    const a = identityDecision(deterministic), b = identityDecision(llm);
    return a === undefined || a === null || a === 'unsure' ? 'abstain' : a === b ? 'agree' : 'disagree';
  },
  // An episode id, or null for "start a new episode"; ids compare as strings so 12 and "12" agree.
  episode: (deterministic, llm) => {
    const a = decisionOf(deterministic), b = decisionOf(llm);
    return a === undefined ? 'abstain' : String(a ?? 'new') === String(b ?? 'new') ? 'agree' : 'disagree';
  },
};

export interface ShadowRow { kind: string; method: string; total: number; withLlm: number; abstained: number; agree: number; disagree: number; agreement: number | null; coverage: number | null }

export function shadowAgreement(db: Database, comparators: Partial<Record<string, Comparator>> = COMPARATORS): ShadowRow[] {
  if (!hasTable(db, 'graph_shadow_decisions')) return [];
  const groups = new Map<string, ShadowRow>();
  for (const row of db.query<{ kind: string; method: string; verdict_json: string; llm_verdict_json: string | null }, []>(
    'SELECT kind,method,verdict_json,llm_verdict_json FROM graph_shadow_decisions ORDER BY kind,method').all()) {
    const key = `${row.kind}\u0000${row.method}`;
    const group = groups.get(key) ?? groups.set(key, { kind: row.kind, method: row.method, total: 0, withLlm: 0, abstained: 0, agree: 0, disagree: 0, agreement: null, coverage: null }).get(key)!;
    group.total++;
    if (row.llm_verdict_json === null) continue;
    group.withLlm++;
    const outcome = (comparators[row.kind] ?? genericComparator)(JSON.parse(row.verdict_json), JSON.parse(row.llm_verdict_json));
    group[outcome === 'abstain' ? 'abstained' : outcome]++;
  }
  return [...groups.values()].map(group => ({ ...group, agreement: ratio(group.agree, group.agree + group.disagree),
    coverage: ratio(group.agree + group.disagree, group.withLlm) }));
}
