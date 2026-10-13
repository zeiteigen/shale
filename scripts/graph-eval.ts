import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Read-only measurement of how well the graph connects things across sources.
 *   bun scripts/graph-eval.ts [database] [--threads resources/graph-eval.json] [--json]
 * Golden threads list member sources by origin and title/uri/text globs; a thread passes when one
 * episode contains a source for every member. Each member reports where it stops: missing, not
 * digested, or digested without an episode.
 */
interface Member { label: string; origin?: string; title?: string; uri?: string; text?: string }
interface Thread { name: string; description?: string; members: Member[] }

const args = process.argv.slice(2);
const flag = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args.splice(index, 2)[1] : undefined; };
const threadsPath = resolve(flag("--threads") ?? resolve(import.meta.dir, "../resources/graph-eval.json"));
const asJson = args.includes("--json");
const path = resolve(args.find(arg => !arg.startsWith("--")) ?? resolve(import.meta.dir, "../data/production.db"));
const db = new Database(path, { readonly: true });
const has = (table: string) => Boolean(db.query("SELECT 1 FROM sqlite_master WHERE name=?").get(table));
/** Zero when the revamp's tables do not exist yet (a database the new host has not opened). */
const count = (sql: string) => {
  try { return db.query<{ n: number }, []>(sql).get()!.n; }
  catch (error) { if (/no such table/.test(String(error))) return 0; throw error; }
};
const SKIPPED = "('browser_activity','web_session')";

const roots = `WITH RECURSIVE root(id,top) AS (SELECT id,id FROM entities WHERE canonical_id IS NULL
  UNION SELECT e.id,root.top FROM entities e JOIN root ON e.canonical_id=root.id)`;
const metrics = {
  sources: count("SELECT count(*) AS n FROM sources"),
  digestible: count(`SELECT count(*) AS n FROM sources WHERE type NOT IN ${SKIPPED}`),
  digested: count("SELECT count(*) AS n FROM graph_source_digests"),
  userInvolved: count("SELECT count(*) AS n FROM graph_source_digests WHERE involvement IN ('participant','author')"),
  modelClaims: count("SELECT count(*) AS n FROM graph_claims WHERE method='llm'"),
  connectorClaims: count("SELECT count(*) AS n FROM graph_claims WHERE method='connector'"),
  activeMerges: count("SELECT count(*) AS n FROM graph_identity_changes WHERE undone_at IS NULL"),
  pendingIdentityPairs: count("SELECT count(*) AS n FROM graph_resolution_queue WHERE state='pending'"),
  registryEntities: count("SELECT count(*) AS n FROM entity_registry_fts"),
  crossOriginEntities: count(`${roots} SELECT count(*) AS n FROM (SELECT root.top FROM root JOIN source_entities se ON se.entity_id=root.id
    JOIN sources s ON s.id=se.source_id JOIN entities t ON t.id=root.top WHERE t.type NOT IN ('Episode','Source')
    GROUP BY root.top HAVING count(DISTINCT s.origin)>=2)`),
  episodes: count("SELECT count(*) AS n FROM graph_episodes g JOIN entities e ON e.id=g.entity_id WHERE e.canonical_id IS NULL"),
  activeEpisodes: count("SELECT count(*) AS n FROM graph_episodes g JOIN entities e ON e.id=g.entity_id WHERE e.canonical_id IS NULL AND g.status='active'"),
  crossOriginEpisodes: count(`${roots} SELECT count(*) AS n FROM (SELECT root.top FROM graph_claims c
    JOIN root ON root.id=c.object_id JOIN graph_episodes g ON g.entity_id=root.top
    JOIN sources s ON s.id=json_extract(c.qualifiers,'$.sourceId')
    WHERE c.predicate='PART_OF_EPISODE' AND c.status IN ('accepted','proposed')
    GROUP BY root.top HAVING count(DISTINCT s.origin)>=2)`),
};

function matches(member: Member) {
  const where = ["1"], params: string[] = [];
  if (member.origin) { where.push("s.origin=?"); params.push(member.origin); }
  if (member.title) { where.push("s.title GLOB ?"); params.push(member.title); }
  if (member.uri) { where.push("s.uri GLOB ?"); params.push(member.uri); }
  if (member.text) { where.push("EXISTS(SELECT 1 FROM chunks c WHERE c.source_id=s.id AND c.text_content GLOB ?)"); params.push(member.text); }
  return db.query<{ id: string; title: string }, string[]>(`SELECT s.id,s.title FROM sources s WHERE ${where.join(" AND ")} ORDER BY s.created_at`).all(...params);
}

function episodesOf(sourceId: string): number[] {
  if (!has("graph_episodes")) return [];
  return db.query<{ id: number }, [string]>(`${roots} SELECT DISTINCT root.top AS id FROM graph_claims c JOIN root ON root.id=c.object_id
    WHERE c.predicate='PART_OF_EPISODE' AND c.status IN ('accepted','proposed') AND json_extract(c.qualifiers,'$.sourceId')=?`).all(sourceId).map(row => row.id);
}

const threads = (JSON.parse(readFileSync(threadsPath, "utf8")) as { threads: Thread[] }).threads.map(thread => {
  const members = thread.members.map(member => {
    const sources = matches(member);
    const digested = sources.filter(source => has("graph_source_digests") && db.query("SELECT 1 FROM graph_source_digests WHERE source_id=?").get(source.id));
    const episodes = [...new Set(sources.flatMap(source => episodesOf(source.id)))];
    const stage = !sources.length ? "not ingested" : !digested.length ? "not digested" : !episodes.length ? "no episode" : "in episode";
    return { label: member.label, sources: sources.length, digested: digested.length, episodes, stage };
  });
  const shared = members.reduce<number[] | null>((common, member) => common === null ? member.episodes
    : common.filter(id => member.episodes.includes(id)), null) ?? [];
  const title = (id: number) => db.query<{ name: string }, [number]>("SELECT coalesce(display_name,name) AS name FROM entities WHERE id=?").get(id)?.name;
  return { name: thread.name, connected: shared.length > 0, episodes: shared.map(id => ({ id, title: title(id) })), members };
});

if (asJson) console.log(JSON.stringify({ database: path, metrics, threads }, null, 2));
else {
  const pct = (a: number, b: number) => b ? `${Math.round(100 * a / b)}%` : "-";
  console.log(`Graph evaluation: ${path}\n`);
  console.log(`Digested sources        ${metrics.digested} / ${metrics.digestible} (${pct(metrics.digested, metrics.digestible)}); user took part in ${metrics.userInvolved}`);
  console.log(`Claims                  ${metrics.modelClaims} model, ${metrics.connectorClaims} connector`);
  console.log(`Identity                ${metrics.activeMerges} merges, ${metrics.pendingIdentityPairs} pairs awaiting adjudication, ${metrics.registryEntities} registry entries`);
  console.log(`Cross-source entities   ${metrics.crossOriginEntities} seen in 2+ origins`);
  console.log(`Episodes                ${metrics.episodes} (${metrics.activeEpisodes} active), ${metrics.crossOriginEpisodes} spanning 2+ origins\n`);
  for (const thread of threads) {
    console.log(`${thread.connected ? "PASS" : "FAIL"}  ${thread.name}${thread.episodes.length ? ` -> ${thread.episodes.map(e => `#${e.id} ${e.title}`).join(", ")}` : ""}`);
    for (const member of thread.members) console.log(`      ${member.label.padEnd(28)} ${String(member.sources).padStart(4)} sources, ${String(member.digested).padStart(4)} digested, ${member.stage}`);
  }
}
