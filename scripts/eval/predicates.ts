import type { Database } from 'bun:sqlite';
import { optionalExport, ratio } from './common';

/**
 * Predicate replay: how scattered the model's relation vocabulary is, and how much of it a canonicaliser maps.
 * Canonicaliser contract (phase P3): a module exporting
 *   canonicalPredicate(predicate: string): string | { predicate: string } | null    // null or 'RELATED_TO' = unmapped
 */
export type PredicateCanonicaliser = (predicate: string) => string | { predicate: string } | null | undefined;
const targetOf = (value: ReturnType<PredicateCanonicaliser>) => typeof value === 'string' ? value : value?.predicate;

export function predicateDistribution(db: Database, method = 'llm') {
  const rows = db.query<{ predicate: string; n: number }, [string]>(
    'SELECT predicate,count(*) AS n FROM graph_claims WHERE method=? GROUP BY predicate ORDER BY n DESC,predicate').all(method);
  const claims = rows.reduce((sum, row) => sum + row.n, 0);
  return { claims, distinct: rows.length, singletons: rows.filter(row => row.n === 1).length, rows };
}

/** Coverage by distinct predicate and by claim volume; RELATED_TO is the documented "unmapped" bucket. */
export function mappingCoverage(rows: { predicate: string; n: number }[], canonical: PredicateCanonicaliser) {
  let mapped = 0, mappedClaims = 0, claims = 0;
  const targets = new Map<string, number>(), unmapped: { predicate: string; n: number }[] = [];
  for (const row of rows) {
    claims += row.n;
    const target = targetOf(canonical(row.predicate));
    if (target && target !== 'RELATED_TO') { mapped++; mappedClaims += row.n; targets.set(target, (targets.get(target) ?? 0) + row.n); }
    else unmapped.push(row);
  }
  return { distinct: rows.length, mapped, mappedClaims, claims, distinctCoverage: ratio(mapped, rows.length), claimCoverage: ratio(mappedClaims, claims),
    targets: targets.size, topUnmapped: unmapped.slice(0, 15) };
}

export async function loadCanonicaliser(modulePath?: string) {
  return optionalExport<PredicateCanonicaliser>(modulePath ? [modulePath] : ['lib/graph/predicates.ts'], ['canonicalPredicate']);
}
