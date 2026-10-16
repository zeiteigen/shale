import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { getSDK, type ShaleSDK } from '@shale/sdk';
import { acquireTaskLease } from '../../lib/task-lease';
import { recordShadow, recordShadowLLM, shadowMode, type ShadowMode } from '../../lib/graph/shadow';
import { canonicalPredicate, isSystemPredicate } from '../../lib/graph/predicates';
import { gazetteerFor, registryNeighbours } from '../../lib/graph/gazetteer';
import { applyPatterns, canonicalResolver, refreshPatterns, type PatternCandidate, type SurfacePattern } from '../../lib/graph/patterns';
import { ASSOCIATION_PREDICATE, commitAssociations, computeAssociations } from '../../lib/graph/association';
import { affiliationFacts, commitDerivations, DEFAULT_RULES, derivationId, evaluateRules, functionalConflicts, linkConflicts } from '../../lib/graph/rules';
import type { KnowledgeGraphSettings } from './settings.types';

/**
 * The graph reasoner: relation discovery and symbolic inference without the model.
 * - association: ASSOCIATED_WITH edges from source co-occurrence (G²), replacing the model's `suggested_connection`;
 * - rules: stratified Datalog conclusions (INTERACTED_WITH, PART_OF closure, email-domain AFFILIATED_WITH);
 * - conflicts: functional-property disagreements linked as `contradicts`;
 * - patterns: surface patterns learned from the model's own claims, fired on recently digested sources.
 * `reasoningMode` shadow (default) records every would-be claim in graph_shadow_decisions (kind `relation`) beside
 * what the model said about the same pair or source; active writes them as proposed claims.
 */

const PATTERN_CURSOR = 'reasoner-pattern-cursor';
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);

/** The model's typed relations between canonical pairs ("a:b" unordered → predicates as "a>P>b"). */
function modelRelations(db: Database, sourceId?: string) {
  const canonical = canonicalResolver(db);
  const rows = db.query<{ predicate: string; subject_id: number; object_id: number; st: string; ot: string }, string[]>(`
    SELECT DISTINCT c.predicate,c.subject_id,c.object_id,s.type AS st,o.type AS ot FROM graph_claims c
    JOIN entities s ON s.id=c.subject_id JOIN entities o ON o.id=c.object_id
    ${sourceId === undefined ? '' : 'JOIN graph_evidence ev ON ev.claim_id=c.id JOIN graph_source_revisions r ON r.id=ev.revision_id AND r.source_id=?'}
    WHERE c.method='llm' AND c.status IN ('proposed','accepted') AND c.polarity=1 AND c.object_id IS NOT NULL`).all(...(sourceId === undefined ? [] : [sourceId]));
  const pairs = new Map<string, string[]>();
  for (const row of rows) {
    if (isSystemPredicate(row.predicate)) continue;
    const s = canonical(row.subject_id), o = canonical(row.object_id);
    if (s === o) continue;
    // suggested_connection is kept verbatim: it is exactly what association edges replace.
    const predicate = row.predicate === 'suggested_connection' ? row.predicate : canonicalPredicate(row.predicate, row.st, row.ot).predicate;
    const k = `${Math.min(s, o)}:${Math.max(s, o)}`;
    const list = pairs.get(k) ?? [];
    const triple = `${s}>${predicate}>${o}`;
    if (!list.includes(triple)) list.push(triple);
    pairs.set(k, list);
  }
  return pairs;
}

export function reasonAssociations(sdk: ShaleSDK, mode: ShadowMode, settings: Partial<KnowledgeGraphSettings>, model = modelRelations(sdk.database)) {
  const db = sdk.database;
  const result = computeAssociations(db, { minCooccurrence: settings.associationMinCooccurrence, minG2: settings.associationMinG2,
    topK: settings.associationTopK, maxDocFraction: settings.associationMaxDocFraction });
  if (mode === 'active') return { edges: result.edges.length, ...commitAssociations(db, sdk.graph, result.edges) };
  db.transaction(() => {
    for (const edge of result.edges) {
      const subject = `association:${edge.a}:${edge.b}`;
      const llm = model.get(`${edge.a}:${edge.b}`);
      recordShadow(db, { kind: 'relation', subject, method: 'association', verdict: { predicate: ASSOCIATION_PREDICATE, subject: edge.a, object: edge.b,
        strength: edge.strength, g2: edge.g2, pmi: edge.pmi, cooccurrences: edge.cooccurrences }, ...(llm ? { llm: { relations: llm } } : {}) });
    }
  })();
  return { edges: result.edges.length, created: 0, updated: 0, retracted: 0, ungrounded: 0 };
}

export function reasonRules(sdk: ShaleSDK, mode: ShadowMode, settings: Partial<KnowledgeGraphSettings>, model = modelRelations(sdk.database)) {
  const db = sdk.database;
  const evaluation = evaluateRules(db, DEFAULT_RULES, { extraFacts: affiliationFacts(db), maxDerivations: settings.ruleMaxDerivationsPerRun ?? 500,
    minConfidence: settings.ruleMinConfidence ?? 0.6 });
  const conflicts = functionalConflicts(db, { limit: settings.ruleMaxDerivationsPerRun ?? 500 });
  if (mode === 'active') {
    const written = commitDerivations(db, sdk.graph, evaluation.derivations);
    return { derived: evaluation.derivations.length, perRule: evaluation.perRule, created: written.created, conflicts: conflicts.length, linked: linkConflicts(db, conflicts) };
  }
  db.transaction(() => {
    for (const derivation of evaluation.derivations) {
      const llm = model.get(`${Math.min(derivation.subject, derivation.object)}:${Math.max(derivation.subject, derivation.object)}`);
      recordShadow(db, { kind: 'relation', subject: derivationId(derivation), method: `rule:${derivation.ruleId}`, verdict: derivation,
        ...(llm ? { llm: { relations: llm } } : {}) });
    }
    for (const conflict of conflicts) recordShadow(db, { kind: 'relation', subject: `contradicts:${conflict.a}|${conflict.b}`, method: 'rule:functional-conflict', verdict: conflict });
  })();
  return { derived: evaluation.derivations.length, perRule: evaluation.perRule, created: 0, conflicts: conflicts.length, linked: 0 };
}

/** Pattern candidates for one source's current digest revision, chunk by chunk, with gazetteer mentions as entity spans. */
export function patternCandidates(db: Database, sourceId: string, revisionId: number, patterns: SurfacePattern[]) {
  const gazetteer = gazetteerFor(db);
  const chunks = db.query<{ chunk_index: number; text_content: string }, [number]>(
    'SELECT chunk_index,text_content FROM graph_revision_chunks WHERE revision_id=? ORDER BY chunk_index LIMIT 200').all(revisionId);
  const out: Array<PatternCandidate & { chunkIndex: number }> = [];
  for (const chunk of chunks) {
    const mentions = gazetteer.match(chunk.text_content, { neighbours: ids => registryNeighbours(db, ids) })
      .map(match => ({ entityId: match.entityId, type: match.type, start: match.start, end: match.end }));
    for (const candidate of applyPatterns(chunk.text_content, mentions, patterns)) out.push({ ...candidate, chunkIndex: chunk.chunk_index });
  }
  return out;
}

export async function reasonPatterns(sdk: ShaleSDK, mode: ShadowMode, settings: Partial<KnowledgeGraphSettings>) {
  const db = sdk.database;
  const { learned, relearned } = refreshPatterns(db, { minPrecision: settings.patternMinPrecision ?? 0.9, minSupport: settings.patternMinSupport ?? 3,
    extensionId: sdk.extensionId });
  const patterns = learned.patterns;
  const cursor = Number(sdk.state.get(PATTERN_CURSOR) ?? 0) || 0;
  const sources = db.query<{ source_id: string; revision_id: number; digested_at: number }, [number, number]>(`SELECT source_id,revision_id,digested_at
    FROM graph_source_digests WHERE digested_at>? ORDER BY digested_at,source_id LIMIT ?`).all(cursor, settings.patternSourcesPerRun ?? 50);
  let candidates = 0, written = 0, agreed = 0;
  for (const source of sources) {
    const found = patterns.length ? patternCandidates(db, source.source_id, source.revision_id, patterns) : [];
    const model = modelRelations(db, source.source_id);
    const modelTriples = [...model.values()].flat();
    db.transaction(() => {
      for (const candidate of found) {
        const subject = `pattern:${source.source_id}:${candidate.subject}:${candidate.predicate}:${candidate.object}`;
        const llm = model.get(`${Math.min(candidate.subject, candidate.object)}:${Math.max(candidate.subject, candidate.object)}`) ?? [];
        if (llm.includes(`${candidate.subject}>${candidate.predicate}>${candidate.object}`)) agreed++;
        if (mode === 'active') {
          const id = `pattern:${sha([source.source_id, candidate.subject, candidate.predicate, candidate.object])}`;
          if (db.query('SELECT 1 FROM graph_claims WHERE id=?').get(id)) continue;
          sdk.graph.claims.add({ id, subject: candidate.subject, predicate: candidate.predicate, object: candidate.object, status: 'proposed',
            method: 'pattern', confidence: candidate.confidence, qualifiers: { patternId: candidate.patternId, sourceId: source.source_id },
            evidence: [{ sourceId: source.source_id, revisionId: source.revision_id, chunkIndex: candidate.chunkIndex, quote: candidate.quote,
              locator: { start: candidate.start, end: candidate.end }, method: 'pattern', confidence: candidate.confidence }] });
          written++;
        } else {
          recordShadow(db, { kind: 'relation', subject, method: 'pattern', verdict: candidate });
          // The model's reading of the same pair in the same source ([] when it related them not at all).
          recordShadowLLM(db, 'relation', subject, { relations: llm });
        }
      }
      // Per source, so recall against the model can be measured too.
      if (mode !== 'active') recordShadow(db, { kind: 'relation', subject: `pattern-source:${source.source_id}`, method: 'pattern',
        verdict: found.map(candidate => `${candidate.subject}>${candidate.predicate}>${candidate.object}`), llm: modelTriples });
    })();
    candidates += found.length;
    sdk.state.set(PATTERN_CURSOR, String(source.digested_at));
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return { patterns: patterns.length, relearned, sources: sources.length, candidates, written, agreed };
}

export async function run(sdkOverride?: ShaleSDK) {
  const sdk = sdkOverride ?? getSDK(import.meta.dir);
  const settings = sdk.settings.getAll() as Partial<KnowledgeGraphSettings>;
  const mode = shadowMode(settings.reasoningMode);
  if (mode === 'off') return { skipped: true };
  const lease = acquireTaskLease(sdk.database, sdk.extensionId, 'graph-reasoner-lease');
  if (!lease) return { busy: true };
  const heartbeat = setInterval(() => { try { lease.renew(); } catch { /* reported on release */ } }, 30_000);
  try {
    const model = modelRelations(sdk.database);
    const associations = reasonAssociations(sdk, mode, settings, model);
    await new Promise(resolve => setTimeout(resolve, 25));
    const rules = reasonRules(sdk, mode, settings, model);
    await new Promise(resolve => setTimeout(resolve, 25));
    const patterns = await reasonPatterns(sdk, mode, settings);
    sdk.logger.log(`Graph reasoner (${mode}): ${associations.edges} association edges (${associations.created} new, ${associations.retracted} retracted), `
      + `${rules.derived} rule conclusions ${JSON.stringify(rules.perRule)}, ${rules.conflicts} conflicts, `
      + `${patterns.patterns} patterns${patterns.relearned ? ' (relearned)' : ''} → ${patterns.candidates} candidates over ${patterns.sources} sources (${patterns.agreed} agree with the model).`);
    return { mode, associations, rules, patterns };
  } finally {
    clearInterval(heartbeat);
    lease.release();
  }
}

if (import.meta.main) run().catch(error => { console.error('Graph reasoning failed:', error); process.exitCode = 1; });
export default run;
