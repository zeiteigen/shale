import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { hasTable, pct } from "./eval/common";
import { clusterAgreement, clusterStats, type Assignment } from "./eval/clustering";
import { BASELINES, episodeBaseline, loadClusterer, referenceMembership } from "./eval/episodes";
import { evaluateExtractor, loadExtractor } from "./eval/extraction";
import { DEFAULT_BANDS, IDENTITY_GATE, bandErrors, evaluateBands, exactNameBaseline, meetsIdentityGate, identityLabels, loadIdentityScorer, parseBands, scoreLabels, type BandResult, type IdentityLabel } from "./eval/identity";
import { loadCanonicaliser, mappingCoverage, predicateDistribution } from "./eval/predicates";
import { shadowAgreement } from "./eval/shadow";

/**
 * Read-only replay of deterministic components against the model's stored decisions, so each can be
 * promoted out of shadow mode on measured agreement rather than hope.
 *   bun scripts/llm-replacement-eval.ts [database] [--json] [--section identity|episodes|extraction|predicates|shadow]
 *     [--bands 0.97:0.03,0.9:0.1] [--identity-module path] [--episodes-module path] [--extractor path]
 *     [--extraction-limit N] [--predicates-module path]
 * Sections whose deterministic component does not exist yet still report the model's baseline and say what was skipped.
 * Metric code and the plug-in contracts live in scripts/eval/*.ts.
 */
const SECTIONS = ["identity", "episodes", "extraction", "predicates", "shadow"] as const;
type Section = typeof SECTIONS[number];

const args = process.argv.slice(2);
const flag = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args.splice(index, 2)[1] : undefined; };
const sectionArg = flag("--section"), bandsArg = flag("--bands"), identityModule = flag("--identity-module"), episodesModule = flag("--episodes-module"),
  extractorModule = flag("--extractor"), extractionLimit = flag("--extraction-limit"), predicatesModule = flag("--predicates-module");
const asJson = args.includes("--json");
if (sectionArg && !SECTIONS.includes(sectionArg as Section)) { console.error(`unknown section "${sectionArg}" (expected ${SECTIONS.join("|")})`); process.exit(2); }
const sections: readonly Section[] = sectionArg ? [sectionArg as Section] : SECTIONS;
const path = resolve(args.find(arg => !arg.startsWith("--")) ?? resolve(import.meta.dir, "../data/production.db"));
const db = new Database(path, { readonly: true });
const bands = bandsArg ? parseBands(bandsArg) : DEFAULT_BANDS;

async function identity() {
  if (!hasTable(db, "graph_resolution_queue")) return { skipped: "no graph_resolution_queue" };
  const { all, train, test } = identityLabels(db);
  const count = (labels: IdentityLabel[]) => ({ labels: labels.length, same: labels.filter(l => l.same).length, different: labels.filter(l => !l.same).length,
    model: labels.filter(l => l.decider === "model").length, rule: labels.filter(l => l.decider === "rule").length });
  // Judge every scorer on the newer test split, overall and on model-decided labels (rule-decided exact names are the easy ones), plus people alone.
  const judge = (scored: ReturnType<typeof scoreLabels>) => {
    const test = evaluateBands(scored, bands);
    return { test, modelLabelsOnly: evaluateBands(scored.filter(row => row.label.decider === "model"), bands),
      person: evaluateBands(scored.filter(row => row.label.type === "Person"), bands),
      gate: { sameP: IDENTITY_GATE, passingBands: test.filter(meetsIdentityGate).map(r => `${r.band.hi}:${r.band.lo}`) },
      errors: bandErrors(db, scored, bands[0]!) };
  };
  const scorers: Record<string, unknown> = { "baseline:exact-name": judge(scoreLabels(db, test, exactNameBaseline(db))) };
  // A scorer that exists but throws (e.g. too few labels to fit) is reported, not fatal: the other sections still run.
  const loaded = await loadIdentityScorer(db, train, identityModule)
    .then(result => "scorer" in result ? { ...result, judged: judge(scoreLabels(db, test, result.scorer)) } : result)
    .catch(error => ({ skipped: `scorer failed: ${error instanceof Error ? error.message : String(error)}` }));
  if ("judged" in loaded) scorers[`linkage (${loaded.from})`] = loaded.judged;
  return { labels: { all: count(all), train: count(train), test: count(test),
    testFrom: test[0] ? new Date(test[0].decidedAt).toISOString() : null }, scorers, ...("skipped" in loaded ? { linkageSkipped: loaded.skipped } : {}) };
}

async function episodes() {
  const baseline = episodeBaseline(db);
  if (!baseline) return { skipped: "no graph_episodes" };
  const { assignment: reference, multi } = referenceMembership(db);
  const restrict = (candidate: Assignment) => new Map([...candidate].filter(([source]) => reference.has(source)));
  const candidates: Record<string, unknown> = {};
  for (const [name, clusterer] of Object.entries(BASELINES)) candidates[`baseline:${name}`] = clusterAgreement(reference, restrict(await clusterer(db)));
  const loaded = await loadClusterer(episodesModule);
  if ("value" in loaded) {
    const assignment = await loaded.value(db);
    candidates[`clustering (${loaded.path})`] = { ...clusterAgreement(reference, restrict(assignment)), stats: clusterStats(assignment) };
  }
  return { ...baseline, reference: { ...clusterStats(reference), sourcesInSeveralEpisodes: multi }, candidates,
    ...("skipped" in loaded ? { clusteringSkipped: loaded.skipped } : {}) };
}

async function extraction() {
  if (!hasTable(db, "graph_source_digests")) return { skipped: "no graph_source_digests" };
  const digests = db.query<{ n: number; entities: number }, []>("SELECT count(*) AS n,coalesce(sum(json_array_length(entity_ids)),0) AS entities FROM graph_source_digests").get()!;
  const loaded = await loadExtractor(extractorModule);
  if ("skipped" in loaded) return { digests: digests.n, referenceEntities: digests.entities, skipped: loaded.skipped };
  return { digests: digests.n, referenceEntities: digests.entities, extractor: loaded.path,
    score: await evaluateExtractor(db, loaded.value, extractionLimit ? Number(extractionLimit) : undefined) };
}

async function predicates() {
  if (!hasTable(db, "graph_claims")) return { skipped: "no graph_claims" };
  const { rows, ...distribution } = predicateDistribution(db);
  const loaded = await loadCanonicaliser(predicatesModule);
  return { ...distribution, top: rows.slice(0, 15),
    ...("value" in loaded ? { canonicaliser: loaded.path, coverage: mappingCoverage(rows, loaded.value) } : { canonicaliserSkipped: loaded.skipped }) };
}

const shadow = async () => hasTable(db, "graph_shadow_decisions") ? { rows: shadowAgreement(db) } : { skipped: "no graph_shadow_decisions (the host has not opened this database since P0)" };

const runners: Record<Section, () => Promise<unknown>> = { identity, episodes, extraction, predicates, shadow };
const report: Record<string, any> = { database: path };
for (const section of sections) report[section] = await runners[section]();

if (asJson) console.log(JSON.stringify(report, null, 2));
else {
  const line = (label: string, text: string) => console.log(`  ${label.padEnd(26)} ${text}`);
  const bandTable = (results: BandResult[]) => { for (const r of results) line(`p>=${r.band.hi} / p<=${r.band.lo}`,
    `decides ${r.decided}/${r.labels} (${pct(r.coverage)}), accuracy ${pct(r.accuracy)}; same P ${pct(r.same.precision)} R ${pct(r.same.recall)}; ` +
    `different P ${pct(r.different.precision)} R ${pct(r.different.recall)}; ~${r.llmRequestsAvoided} requests avoided`); };
  console.log(`LLM replacement evaluation: ${path}`);
  for (const section of sections) {
    const r = report[section];
    console.log(`\n[${section}]`);
    if (r.skipped && Object.keys(r).length === 1) { line("skipped", r.skipped); continue; }
    if (section === "identity") {
      line("labels", `${r.labels.all.labels} (${r.labels.all.same} same, ${r.labels.all.different} different; ${r.labels.all.model} model, ${r.labels.all.rule} rule)`);
      line("time split", `train ${r.labels.train.labels} / test ${r.labels.test.labels} (test from ${r.labels.testFrom?.slice(0, 10) ?? "-"})`);
      for (const [name, scored] of Object.entries<any>(r.scorers)) {
        console.log(`  ${name}: test split`); bandTable(scored.test);
        console.log(`  ${name}: model-decided test labels`); bandTable(scored.modelLabelsOnly);
        console.log(`  ${name}: Person test labels`); bandTable(scored.person);
        line("promotion gate", `same precision >= ${scored.gate.sameP}: ${scored.gate.passingBands.length ? `met at ${scored.gate.passingBands.join(", ")}` : "not met"}`);
        for (const e of scored.errors.slice(0, 5)) line("  wrong at strictest band", `p=${e.p} ${e.type} "${e.mention}" vs "${e.candidate}" (model: ${e.label})`);
      }
      if (r.linkageSkipped) line("linkage scorer", `skipped (${r.linkageSkipped})`);
    } else if (section === "episodes") {
      line("episodes", `${r.episodes}; reference ${r.reference.items} sources in ${r.reference.clusters} clusters, ${r.reference.singletons} singletons, largest ${r.reference.largest}`);
      line("sources in 2+ episodes", String(r.reference.sourcesInSeveralEpisodes));
      line("membership by basis", Object.entries(r.membershipByBasis).map(([k, v]) => `${k} ${v}`).join(", "));
      line("digest episode states", Object.entries(r.digestEpisodeStates).map(([k, v]) => `${k} ${v}`).join(", "));
      for (const [name, c] of Object.entries<any>(r.candidates)) line(name, `pairwise P ${pct(c.pairwise.precision)} R ${pct(c.pairwise.recall)} F1 ${pct(c.pairwise.f1)}; ` +
        `B-cubed P ${pct(c.bcubed.precision)} R ${pct(c.bcubed.recall)} F1 ${pct(c.bcubed.f1)}`);
      if (r.clusteringSkipped) line("clustering", `skipped (${r.clusteringSkipped})`);
    } else if (section === "extraction") {
      line("reference", `${r.digests} digests, ${r.referenceEntities} linked entities`);
      if (r.score) line(r.extractor, `recall micro ${pct(r.score.microRecall)} macro ${pct(r.score.macroRecall)}, precision ${pct(r.score.microPrecision)}, ${r.score.fullRecallSources}/${r.score.sources} sources fully recalled`);
      else line("extractor", `skipped (${r.skipped})`);
    } else if (section === "predicates") {
      line("model claims", `${r.claims}: ${r.distinct} distinct predicates, ${r.singletons} used once`);
      line("top", r.top.slice(0, 8).map((row: any) => `${row.predicate} ${row.n}`).join(", "));
      if (r.coverage) line(`mapped by ${r.canonicaliser}`, `${r.coverage.mapped}/${r.coverage.distinct} predicates (${pct(r.coverage.distinctCoverage)}), ${pct(r.coverage.claimCoverage)} of claims, onto ${r.coverage.targets} targets`);
      else line("canonicaliser", `skipped (${r.canonicaliserSkipped})`);
    } else if (section === "shadow") {
      if (!r.rows.length) line("decisions", "none recorded yet");
      for (const row of r.rows) line(`${row.kind}/${row.method}`, `${row.total} decisions, ${row.withLlm} with a model verdict; agree ${row.agree}, disagree ${row.disagree}, abstain ${row.abstained} ` +
        `(agreement ${pct(row.agreement)}, coverage ${pct(row.coverage)})`);
    }
  }
}
