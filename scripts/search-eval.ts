import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { optionalExport, pct } from "./eval/common";
import { knownItemQueries, judgedQueries, nearDuplicates, runQueries, summarise, threadQueries, type EvalQuery, type QueryResult, type Ranker } from "./eval/search";

/**
 * Read-only search relevance evaluation (MRR, nDCG@5/10, Recall@50, top-5 duplicate rate, p50/p95 latency).
 *   bun scripts/search-eval.ts [database] [--ranker bm25|engine|<module path>] [--set known|threads|judged|all] [--json]
 *     [--limit N] [--seed S] [--threads resources/graph-eval.json] [--judged resources/search-eval.json]
 * --limit is the known-item sample size (default 400 sources, up to four queries each).
 * A ranker module exports `rank`, `searchSources`, or a default function `(db, query, { limit }) => ids | { sourceId }[]`.
 * Metric code and the query sets live in scripts/eval/search.ts.
 */
// Importing sdk/* opens lib/db-init's default database and migrates it; point it at memory so this stays read-only.
process.env.SHALE_DB_PATH = ":memory:";

const SETS = ["known", "threads", "judged"] as const;
const args = process.argv.slice(2);
const flag = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args.splice(index, 2)[1] : undefined; };
const rankerArg = flag("--ranker") ?? "bm25", setArg = flag("--set") ?? "all", limitArg = flag("--limit"), seedArg = flag("--seed");
const threadsPath = resolve(flag("--threads") ?? resolve(import.meta.dir, "../resources/graph-eval.json"));
const judgedPath = resolve(flag("--judged") ?? resolve(import.meta.dir, "../resources/search-eval.json"));
const asJson = args.includes("--json");
if (setArg !== "all" && !SETS.includes(setArg as typeof SETS[number])) { console.error(`unknown set "${setArg}" (expected ${SETS.join("|")}|all)`); process.exit(2); }
const sets = setArg === "all" ? SETS : [setArg as typeof SETS[number]];
const path = resolve(args.find(arg => !arg.startsWith("--")) ?? resolve(import.meta.dir, "../data/production.db"));
const db = new Database(path, { readonly: true });

const ids = (rows: readonly unknown[]) => rows.map(row => typeof row === "string" ? row : (row as { sourceId: string }).sourceId);
async function loadRanker(name: string): Promise<Ranker | { skipped: string }> {
  if (name === "bm25") {
    const { searchMemory } = await import("../sdk/memory/search");
    return (db, query, { limit }) => {
      const hits: string[] = [];
      for (let offset: number | null = 0; offset !== null && hits.length < limit;) {
        const page = searchMemory(db, { query, limit: Math.min(100, limit - hits.length), offset });
        hits.push(...page.hits.map(hit => hit.sourceId)); offset = page.nextOffset;
      }
      return hits;
    };
  }
  const loaded = await optionalExport<(...args: unknown[]) => unknown>(name === "engine" ? ["sdk/retrieval/engine.ts"] : [name], name === "engine" ? ["searchSources"] : ["rank", "searchSources", "default"]);
  if ("skipped" in loaded) return loaded;
  return async (db, query, options) => ids(await loaded.value(db, query, options) as unknown[]);
}

const ranker = await loadRanker(rankerArg);
if ("skipped" in ranker) {
  if (asJson) console.log(JSON.stringify({ database: path, ranker: rankerArg, skipped: ranker.skipped }, null, 2));
  else console.log(`Search evaluation: ${path}\nranker ${rankerArg} skipped (${ranker.skipped})`);
  process.exit(0);
}

const duplicates = nearDuplicates(db);
const notes: Record<string, string> = {};
const queries: EvalQuery[] = [];
for (const set of sets) {
  const loaded = set === "known" ? { queries: knownItemQueries(db, { sample: limitArg ? Number(limitArg) : 400, seed: seedArg ? Number(seedArg) : 1, duplicates }) }
    : set === "threads" ? threadQueries(db, threadsPath) : judgedQueries(judgedPath);
  if (loaded.note) notes[set] = loaded.note;
  queries.push(...loaded.queries);
}
const results = await runQueries(db, ranker, queries, duplicates);

const groups = new Map<string, QueryResult[]>();
for (const result of results) for (const key of [result.set, ...(result.set === "known" ? [`known/${result.kind}`] : [])])
  (groups.get(key) ?? groups.set(key, []).get(key)!).push(result);
const summary = Object.fromEntries([...groups].map(([key, rows]) => [key, summarise(rows)]));

if (asJson) console.log(JSON.stringify({ database: path, ranker: rankerArg, summary, notes,
  queries: results.map(({ ranked, ...result }) => ({ ...result, top: ranked.slice(0, 10) })) }, null, 2));
else {
  const num = (value: number | null) => value === null ? "-" : value.toFixed(3), ms = (value: number | null) => value === null ? "-" : `${value.toFixed(0)}ms`;
  console.log(`Search evaluation: ${path} (ranker ${rankerArg})\n`);
  console.log(`${"set".padEnd(18)} ${"queries".padStart(8)} ${"judged".padStart(7)} ${"empty".padStart(6)}   MRR     nDCG@5  nDCG@10 R@50    dup@5   p50     p95`);
  for (const [key, s] of Object.entries(summary)) console.log(`${key.padEnd(18)} ${String(s.queries).padStart(8)} ${String(s.judged).padStart(7)} ${String(s.empty).padStart(6)}   ` +
    `${num(s.mrr).padEnd(7)} ${num(s.ndcg5).padEnd(7)} ${num(s.ndcg10).padEnd(7)} ${num(s.recall50).padEnd(7)} ${pct(s.dup5).padEnd(7)} ${ms(s.p50ms).padEnd(7)} ${ms(s.p95ms)}` +
    (s.errors ? `  (${s.errors} errors)` : ""));
  for (const [set, note] of Object.entries(notes)) console.log(`\nNote (${set}): ${note}`);
  const worst = results.filter(r => r.set !== "known" && r.ndcg5 !== null).sort((a, b) => a.ndcg5! - b.ndcg5!).slice(0, 10);
  if (worst.length) { console.log("\nWeakest judged/thread queries (nDCG@5):"); for (const r of worst) console.log(`  ${num(r.ndcg5)}  ${r.query}`); }
}
