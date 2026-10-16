import type { Database } from 'bun:sqlite';
import { typeFamily } from './ontology';
import { canonicalResolver } from './patterns';

/**
 * Statistical association edges. Two canonical entities that keep turning up in the same sources are related,
 * whatever the relation is called. Dunning's log-likelihood ratio (G²) over the 2×2 source contingency table says
 * how surprising their co-occurrence is given how often each occurs, and is robust for the small counts of a
 * personal corpus where PMI alone overrates rare pairs. Edges become symmetric ASSOCIATED_WITH claims (method
 * `association`, always proposed) that replace the model's free-form `suggested_connection` claims and feed
 * search expansion: strength (and confidence) is G² squashed onto [0,1), so the retrieval confidence floor
 * applies to them like any other proposed link.
 */

export const ASSOCIATION_METHOD = 'association';
export const ASSOCIATION_PREDICATE = 'ASSOCIATED_WITH';

/** Families worth associating; connector containers (pages, chats, sessions) and Episodes are not things. */
const FAMILIES = new Set(['Person', 'Organization', 'Project', 'Opportunity', 'Event', 'Artifact', 'Product', 'Place', 'Concept', 'Course', 'Community']);

export interface AssociationOptions {
  /** Sources two entities must share. */
  minCooccurrence?: number;
  /** G² floor; 10.83 is p < 0.001 for one degree of freedom. */
  minG2?: number;
  /** Edges kept per entity (an edge survives when it is in either endpoint's top K). */
  topK?: number;
  /** Entities in more than this fraction of sources are ubiquitous (the user's mail provider, LinkedIn) and skipped. */
  maxDocFraction?: number;
  /** Sources mentioning more entities than this are lists, not contexts, and do not count pairs. */
  maxEntitiesPerSource?: number;
  /** G² at which strength reaches 1 − 1/e. */
  scale?: number;
}

export interface AssociationEdge {
  a: number;
  b: number;
  g2: number;
  pmi: number;
  cooccurrences: number;
  strength: number;
  /** Shared sources, most recent first (bounded); grounding for access checks. */
  sources: string[];
}

const xlogx = (x: number) => x > 0 ? x * Math.log(x) : 0;

/** Dunning G² for a 2×2 table (k11 both, k12 a only, k21 b only, k22 neither). */
export function g2(k11: number, k12: number, k21: number, k22: number): number {
  const n = k11 + k12 + k21 + k22;
  const value = 2 * (xlogx(k11) + xlogx(k12) + xlogx(k21) + xlogx(k22) + xlogx(n)
    - xlogx(k11 + k12) - xlogx(k21 + k22) - xlogx(k11 + k21) - xlogx(k12 + k22));
  return Math.max(0, value);
}

export const strengthOf = (value: number, scale = 40) => Math.round((1 - Math.exp(-value / scale)) * 1000) / 1000;

/** The self identity group: associating every entity with the user says nothing. */
function selfId(db: Database, canonical: (id: number) => number): number | null {
  const row = db.query<{ id: number }, []>("SELECT id FROM entities WHERE stable_id='self'").get();
  return row ? canonical(row.id) : null;
}

/**
 * Source → canonical entities, from connector incidence (source_entities) and digest signals, for sources that
 * still exist. Types outside the associable families, retired entities, and the self group are dropped.
 */
export function incidence(db: Database): { sources: Map<string, Set<number>>; updatedAt: Map<string, number> } {
  const canonical = canonicalResolver(db);
  const self = selfId(db, canonical);
  const types = new Map(db.query<{ id: number; type: string }, []>('SELECT id,type FROM entities').all().map(row => [row.id, row.type]));
  const retired = new Set(db.query<{ entity_id: number }, []>('SELECT entity_id FROM graph_entity_retirements').all().map(row => row.entity_id));
  const sources = new Map<string, Set<number>>(), updatedAt = new Map<string, number>();
  const rows = db.query<{ source_id: string; entity_id: number; updated_at: number }, []>(`
    SELECT x.source_id,x.entity_id,s.updated_at FROM (SELECT source_id,entity_id FROM source_entities
      UNION SELECT source_id,entity_id FROM graph_digest_signals) x JOIN sources s ON s.id=x.source_id`).all();
  for (const row of rows) {
    updatedAt.set(row.source_id, row.updated_at);
    const id = canonical(row.entity_id);
    if (id === self || retired.has(id) || !FAMILIES.has(typeFamily(types.get(id) ?? ''))) continue;
    const set = sources.get(row.source_id) ?? new Set<number>();
    set.add(id); sources.set(row.source_id, set);
  }
  return { sources, updatedAt };
}

/** Score every co-occurring pair and keep the strong ones, bounded per entity. */
export function computeAssociations(db: Database, options: AssociationOptions = {}) {
  const minCo = options.minCooccurrence ?? 2, minG2 = options.minG2 ?? 10.83, topK = options.topK ?? 5;
  const maxFraction = options.maxDocFraction ?? 0.05, maxPerSource = options.maxEntitiesPerSource ?? 60;
  const { sources, updatedAt } = incidence(db);
  // N counts every source that could have mentioned something, including those whose entities were all filtered.
  const n = Math.max(sources.size, db.query<{ n: number }, []>(`SELECT count(DISTINCT source_id) AS n FROM (SELECT source_id FROM source_entities
    UNION SELECT source_id FROM graph_digest_signals) x JOIN sources s ON s.id=x.source_id`).get()!.n);
  const df = new Map<number, number>();
  for (const set of sources.values()) for (const id of set) df.set(id, (df.get(id) ?? 0) + 1);
  // A small corpus has no ubiquitous entities: below twenty sources the fraction would cut ordinary repeats.
  const ubiquitous = new Set([...df].filter(([, count]) => count > Math.max(20, maxFraction * n)).map(([id]) => id));
  const pairs = new Map<string, string[]>();
  const ordered = [...sources.entries()].sort((a, b) => (updatedAt.get(b[0]) ?? 0) - (updatedAt.get(a[0]) ?? 0));
  for (const [sourceId, set] of ordered) {
    const ids = [...set].filter(id => !ubiquitous.has(id) && (df.get(id) ?? 0) >= minCo).sort((a, b) => a - b);
    if (ids.length < 2 || ids.length > maxPerSource) continue;
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const k = `${ids[i]}:${ids[j]}`;
      const list = pairs.get(k);
      if (list) list.push(sourceId); else pairs.set(k, [sourceId]);
    }
  }
  const scored: AssociationEdge[] = [];
  for (const [k, shared] of pairs) {
    const k11 = shared.length;
    if (k11 < minCo) continue;
    const [a, b] = k.split(':').map(Number) as [number, number];
    const na = df.get(a)!, nb = df.get(b)!;
    // Only positive association: co-occurring more often than independence predicts.
    if (k11 * n <= na * nb) continue;
    const value = g2(k11, na - k11, nb - k11, n - na - nb + k11);
    if (value < minG2) continue;
    scored.push({ a, b, g2: Math.round(value * 100) / 100, pmi: Math.round(Math.log2(k11 * n / (na * nb)) * 100) / 100,
      cooccurrences: k11, strength: strengthOf(value, options.scale), sources: shared.slice(0, 20) });
  }
  scored.sort((x, y) => y.g2 - x.g2 || x.a - y.a || x.b - y.b);
  const rank = new Map<number, number>();
  const edges = scored.filter(edge => {
    const ra = rank.get(edge.a) ?? 0, rb = rank.get(edge.b) ?? 0;
    rank.set(edge.a, ra + 1); rank.set(edge.b, rb + 1);
    return ra < topK || rb < topK;
  });
  return { edges, sources: n, entities: df.size, ubiquitous: ubiquitous.size, candidates: pairs.size };
}

export const associationId = (a: number, b: number) => `association:${Math.min(a, b)}:${Math.max(a, b)}`;

interface GraphWriter {
  claims: { add(input: { id: string; subject: number; predicate: string; object: number; status: 'proposed'; method: string;
    confidence: number; strength: number; qualifiers: Record<string, number> }): unknown };
  evidence: { add(claimId: string, input: { sourceId: string; stance: 'supports'; method: string }): string };
  relations: { get(name: string): unknown; define(definition: { name: string; description?: string; symmetric?: boolean }): void };
}

/**
 * Write edges as proposed ASSOCIATED_WITH claims, idempotently (id from the pair), and retract association claims
 * that no longer clear the thresholds. Every claim is grounded in the shared sources it was counted from, so a
 * restricted profile sees an edge only when it can see one of them (claims with no evidence would be visible to
 * every profile that sees both entities). An edge with no current source revision to cite is not written.
 */
export function commitAssociations(db: Database, graph: GraphWriter, edges: AssociationEdge[], options: { maxEvidence?: number } = {}) {
  if (!graph.relations.get(ASSOCIATION_PREDICATE)) graph.relations.define({ name: ASSOCIATION_PREDICATE, symmetric: true,
    description: 'statistically associated: the two keep appearing in the same sources (Dunning G²)' });
  const maxEvidence = options.maxEvidence ?? 5;
  const current = db.query<{ id: number }, [string]>('SELECT r.id FROM graph_source_revisions r JOIN sources s ON s.id=r.source_id AND s.hash=r.hash WHERE s.id=?');
  const existing = new Map(db.query<{ id: string; status: string; strength: number; qualifiers: string }, [string]>(
    'SELECT id,status,strength,qualifiers FROM graph_claims WHERE method=?').all(ASSOCIATION_METHOD).map(row => [row.id, row]));
  const cited = db.query<{ source_id: string }, [string]>(`SELECT DISTINCT r.source_id FROM graph_evidence ev JOIN graph_source_revisions r ON r.id=ev.revision_id WHERE ev.claim_id=?`);
  let created = 0, updated = 0, retracted = 0, ungrounded = 0;
  const keep = new Set<string>();
  db.transaction(() => {
    for (const edge of edges) {
      const id = associationId(edge.a, edge.b);
      const grounded = edge.sources.filter(source => current.get(source)).slice(0, maxEvidence);
      if (!grounded.length) { ungrounded++; continue; }
      keep.add(id);
      const qualifiers = { g2: edge.g2, pmi: edge.pmi, cooccurrences: edge.cooccurrences };
      const row = existing.get(id);
      if (!row) {
        graph.claims.add({ id, subject: Math.min(edge.a, edge.b), predicate: ASSOCIATION_PREDICATE, object: Math.max(edge.a, edge.b), status: 'proposed',
          method: ASSOCIATION_METHOD, confidence: edge.strength, strength: edge.strength, qualifiers });
        for (const source of grounded) graph.evidence.add(id, { sourceId: source, stance: 'supports', method: ASSOCIATION_METHOD });
        created++;
        continue;
      }
      const stored = JSON.parse(row.qualifiers) as Record<string, unknown>;
      if (row.status === 'proposed' && row.strength === edge.strength && Object.entries(qualifiers).every(([name, value]) => stored[name] === value)) continue;
      // Machine-maintained statistics: refresh in place (and revive a retracted edge that is strong again).
      db.query("UPDATE graph_claims SET strength=?,confidence=?,qualifiers=?,status='proposed' WHERE id=? AND method=? AND status IN ('proposed','retracted','stale')")
        .run(edge.strength, edge.strength, JSON.stringify(qualifiers), id, ASSOCIATION_METHOD);
      const have = new Set(cited.all(id).map(r => r.source_id));
      for (const source of grounded) if (!have.has(source)) graph.evidence.add(id, { sourceId: source, stance: 'supports', method: ASSOCIATION_METHOD });
      updated++;
    }
    for (const [id, row] of existing) if (!keep.has(id) && row.status === 'proposed') {
      db.query("UPDATE graph_claims SET status='retracted' WHERE id=? AND method=?").run(id, ASSOCIATION_METHOD);
      retracted++;
    }
  })();
  return { created, updated, retracted, ungrounded };
}
