import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

/**
 * Tune the search engine's feature weights by coordinate ascent (sdk/retrieval/ltr.ts) on read-only data.
 *   bun scripts/search-tune.ts [database] [--known N] [--seed S] [--rounds R] [--fold 0|1] [--save <scratch copy>] [--json]
 * Training: synthetic known-item queries (seed 7 by default, a different sample from the evaluation's seed 1) plus
 * one half of the hand-judged queries (--fold picks which); validation: the other judged half and the evaluation's own
 * known-item sample. Running both folds is a two-fold cross-validation of the method.
 * Tuned weights are worth keeping only when the held-out judged nDCG@5 improves over the starting weights; the
 * script says so, and `--save` writes them to extension_state of a scratch copy (never the production database).
 */
// Importing sdk/* opens lib/db-init's default database; keep it in memory so this stays read-only.
process.env.SHALE_DB_PATH = ":memory:";

const { parseQuery } = await import("../sdk/retrieval/query");
const { prepareSearch, rankPrepared, searchWeights } = await import("../sdk/retrieval/engine");
const { DEFAULT_SEARCH_WEIGHTS, FEATURES, FIXED_FEATURES } = await import("../sdk/retrieval/features");
const { DEFAULT_DIVERSITY } = await import("../sdk/retrieval/engine");
const { coordinateAscent } = await import("../sdk/retrieval/ltr");
const { judgedQueries, knownItemQueries, ndcg, nearDuplicates, reciprocalRank } = await import("./eval/search");
const { fnv1a32 } = await import("../lib/text/tokenize");

const args = process.argv.slice(2);
const flag = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args.splice(index, 2)[1] : undefined; };
const knownCount = Number(flag("--known") ?? 300), seed = Number(flag("--seed") ?? 7), rounds = Number(flag("--rounds") ?? 4);
const savePath = flag("--save");
const fold = Number(flag("--fold") ?? 0);
const asJson = args.includes("--json");
const path = resolve(args.find(arg => !arg.startsWith("--")) ?? resolve(import.meta.dir, "../data/production.db"));
const db = new Database(path, { readonly: true });

const duplicates = nearDuplicates(db);
const judged = judgedQueries(resolve(import.meta.dir, "../resources/search-eval.json")).queries;
// A deterministic half split of the judged queries by hash.
const isTrain = (query: string) => fnv1a32(query) % 2 === fold;
const sets = {
  trainKnown: knownItemQueries(db, { sample: knownCount, seed, duplicates }),
  trainJudged: judged.filter(query => isTrain(query.query)),
  heldJudged: judged.filter(query => !isTrain(query.query)),
  heldKnown: knownItemQueries(db, { sample: Math.min(knownCount, 400), seed: 1, duplicates }),
};

const started = performance.now();
const prepare = (queries: typeof judged) => queries.map(query => ({ query, prepared: prepareSearch(db, parseQuery(db, query.query), { ignoreTuned: true }) }));
const prepared = Object.fromEntries(Object.entries(sets).map(([name, queries]) => [name, prepare(queries)])) as Record<keyof typeof sets, ReturnType<typeof prepare>>;
const prepMs = performance.now() - started;

type Values = Record<string, number>;
const weightsOf = (values: Values) => Object.fromEntries(FEATURES.map(feature => [feature, values[feature] ?? 0])) as typeof DEFAULT_SEARCH_WEIGHTS;
function metrics(rows: ReturnType<typeof prepare>, values: Values) {
  let n5 = 0, rr = 0, count = 0;
  for (const { query, prepared: entry } of rows) {
    const ranked = rankPrepared(entry, weightsOf(values), { diversity: values.diversity }).map(item => item.candidate.sourceId);
    const value = ndcg(ranked, query.judgments, 5);
    if (value === null) continue;
    n5 += value; rr += reciprocalRank(ranked, query.judgments); count++;
  }
  return { ndcg5: count ? n5 / count : 0, mrr: count ? rr / count : 0, queries: count };
}
const objective = (values: Values) => 0.5 * metrics(prepared.trainKnown, values).ndcg5 + 0.5 * metrics(prepared.trainJudged, values).ndcg5;

const initial: Values = { ...searchWeights(db, null, true), diversity: DEFAULT_DIVERSITY };
const parameters = [...FEATURES.filter(name => !FIXED_FEATURES.has(name)).map(name => ({ name, sign: (DEFAULT_SEARCH_WEIGHTS[name] < 0 ? -1 : 1) as 1 | -1 })), { name: "diversity", min: 0.4, max: 1 }];
const result = coordinateAscent(initial, parameters, objective, { rounds, onStep: (round, name, value) => { if (!asJson) console.log(`  round ${round + 1}: ${name} → ${value.toFixed(4)}`); } });

const report = (values: Values) => Object.fromEntries((Object.keys(prepared) as Array<keyof typeof prepared>).map(name => [name, metrics(prepared[name], values)]));
const before = report(initial), after = report(result.values);
const accepted = after.heldJudged!.ndcg5 > before.heldJudged!.ndcg5;
const tuned = { weights: Object.fromEntries(FEATURES.map(feature => [feature, Math.round(result.values[feature]! * 1000) / 1000])), diversity: Math.round(result.values.diversity! * 100) / 100 };

if (asJson) console.log(JSON.stringify({ database: path, before, after, accepted, tuned, evaluations: result.evaluations, prepareMs: Math.round(prepMs) }, null, 2));
else {
  console.log(`\nSearch weight tuning: ${path} (${result.evaluations} evaluations, preparation ${Math.round(prepMs)} ms)`);
  console.log(`${"set".padEnd(12)} ${"queries".padStart(7)}   nDCG@5 before → after    MRR before → after`);
  for (const name of Object.keys(before)) {
    const b = before[name]!, a = after[name]!;
    console.log(`${name.padEnd(12)} ${String(a.queries).padStart(7)}   ${b.ndcg5.toFixed(3)} → ${a.ndcg5.toFixed(3)}          ${b.mrr.toFixed(3)} → ${a.mrr.toFixed(3)}`);
  }
  console.log(`\n${accepted ? "ACCEPT" : "REJECT"}: held-out judged nDCG@5 ${before.heldJudged!.ndcg5.toFixed(3)} → ${after.heldJudged!.ndcg5.toFixed(3)}`);
  console.log(JSON.stringify(tuned));
}

if (savePath) {
  const target = resolve(savePath);
  if (target === resolve(import.meta.dir, "../data/production.db") || !existsSync(target)) { console.error(`refusing to write ${target}: pass an existing scratch copy`); process.exit(2); }
  if (!accepted) { console.error("not saved: held-out judged nDCG@5 did not improve"); process.exit(1); }
  const copy = new Database(target);
  copy.query(`INSERT INTO extension_state(extension_id,state_key,value,updated_at) VALUES('knowledge-graph','search-weights',?,?)
    ON CONFLICT(extension_id,state_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(JSON.stringify({ ...tuned, tunedAt: Date.now() }), Date.now());
  copy.close();
  console.log(`saved to extension_state of ${target}`);
}
