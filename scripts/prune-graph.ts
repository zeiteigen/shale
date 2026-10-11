import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ensureGraphSchema } from "../lib/graph/schema";
import { graphIdentity } from "../sdk/graph/source";
import { canonicalUrl } from "../extensions/browser/filter";
import { isDecorativeImage, isGenericAnchor } from "../extensions/browser/page-graph";
import { isUiChromeTopic, sameLabel } from "../extensions/browser/identity";

/**
 * One-time graph clutter cleanup. Dry-run by default: every step runs inside a transaction that is
 * rolled back, and the before/after profile is printed. `--apply` writes a VACUUM INTO backup first.
 *
 *   bun scripts/prune-graph.ts [db-path] [--apply]
 */
const args = process.argv.slice(2);
const apply = args.includes("--apply");
const path = resolve(args.find((a) => !a.startsWith("--")) ?? resolve(import.meta.dir, "../data/production.db"));
if (!existsSync(path)) throw new Error(`No database at ${path}`);
const db = new Database(path);
db.run("PRAGMA busy_timeout = 5000");
db.run("PRAGMA foreign_keys = ON");
ensureGraphSchema(db);

const LIVE = "('accepted','proposed','disputed')";
const n = (sql: string, ...p: (string | number)[]) => db.query<{ n: number }, (string | number)[]>(sql).get(...p)!.n;
const ids = (sql: string, ...p: (string | number)[]) => db.query<{ id: number }, (string | number)[]>(sql).all(...p).map((r) => r.id);
const claimIds = (sql: string, ...p: (string | number)[]) => db.query<{ id: string }, (string | number)[]>(sql).all(...p).map((r) => r.id);

function profile() {
  return {
    entities: n("SELECT count(*) n FROM entities"),
    visibleNodes: n("SELECT count(*) n FROM entities WHERE canonical_id IS NULL AND type!='Event'"),
    connectedVisibleNodes: n(`SELECT count(*) n FROM entities e WHERE canonical_id IS NULL AND type!='Event' AND EXISTS(
      SELECT 1 FROM graph_claims c WHERE (c.subject_id=e.id OR c.object_id=e.id) AND c.object_id IS NOT NULL AND c.status IN ${LIVE}
      AND c.predicate NOT LIKE 'ROLE:%' AND c.predicate NOT IN ('IN_VAULT','IN_DIRECTORY'))`),
    edges: n("SELECT count(*) n FROM edges"),
    staleOnlyEdges: n(`SELECT count(*) n FROM edges e WHERE NOT EXISTS(SELECT 1 FROM graph_claims c WHERE c.subject_id=e.source_entity_id
      AND c.object_id=e.target_entity_id AND c.predicate=e.relation AND c.polarity=1 AND c.status IN ${LIVE})`),
    claims: n("SELECT count(*) n FROM graph_claims"),
    textFragmentEntities: n("SELECT count(*) n FROM entities WHERE canonical_id IS NULL AND name LIKE '%#:~:text=%'"),
    activityEvents: n("SELECT count(*) n FROM graph_events WHERE kind IN ('browser_attention','browser_activation','browser_close')"),
    faviconImages: images().filter((i) => isDecorativeImage({ url: i.url })).length,
    historyRecords: n("SELECT count(*) n FROM entities WHERE type='HistoryRecord'"),
    byType: Object.fromEntries(db.query<{ type: string; n: number }, []>(
      "SELECT type,count(*) n FROM entities WHERE canonical_id IS NULL GROUP BY type ORDER BY n DESC").all().map((r) => [r.type, r.n])),
  };
}

/** Connector entities keep their identity key as the legacy name or a connector-key alias. */
function keyOf(id: number, name: string): string {
  if (/^https?:/i.test(name)) return name;
  return db.query<{ alias: string }, [number]>(
    "SELECT alias FROM graph_aliases WHERE entity_id=? AND scope='connector-key' ORDER BY alias LIMIT 1").get(id)?.alias ?? name;
}
function images() {
  return db.query<{ id: number; name: string }, []>("SELECT id,name FROM entities WHERE type='Image'").all()
    .map((e) => ({ id: e.id, url: keyOf(e.id, e.name) }));
}

// Temp tables make deletes set-based rather than one statement per row.
db.run("CREATE TEMP TABLE IF NOT EXISTS prune_claims(id TEXT PRIMARY KEY)");
db.run("CREATE TEMP TABLE IF NOT EXISTS prune_entities(id INTEGER PRIMARY KEY)");

/** Remove claims with every row that references them. */
function deleteClaims(list: string[]) {
  if (!list.length) return 0;
  db.run("DELETE FROM prune_claims");
  const insert = db.query("INSERT OR IGNORE INTO prune_claims VALUES(?)");
  for (const id of list) insert.run(id);
  const triples = db.query<{ s: number; o: number; p: string }, []>(
    "SELECT DISTINCT subject_id s,object_id o,predicate p FROM graph_claims WHERE object_id IS NOT NULL AND id IN (SELECT id FROM prune_claims)").all();
  db.run(`DELETE FROM graph_evidence_history WHERE evidence_id IN (SELECT id FROM graph_evidence WHERE claim_id IN (SELECT id FROM prune_claims))`);
  db.run(`DELETE FROM graph_evidence WHERE claim_id IN (SELECT id FROM prune_claims)`);
  db.run(`DELETE FROM graph_dependencies WHERE claim_id IN (SELECT id FROM prune_claims) OR depends_on IN (SELECT id FROM prune_claims)`);
  db.run(`DELETE FROM graph_claim_links WHERE source_id IN (SELECT id FROM prune_claims) OR target_id IN (SELECT id FROM prune_claims)`);
  db.run(`DELETE FROM graph_reviews WHERE claim_id IN (SELECT id FROM prune_claims)`);
  db.run(`DELETE FROM graph_status_history WHERE claim_id IN (SELECT id FROM prune_claims)`);
  db.run(`DELETE FROM graph_participants WHERE claim_id IN (SELECT id FROM prune_claims)`);
  db.run(`UPDATE graph_events SET claim_id=NULL WHERE claim_id IN (SELECT id FROM prune_claims)`);
  db.run(`DELETE FROM graph_claims WHERE id IN (SELECT id FROM prune_claims)`);
  db.run(`DELETE FROM graph_record_versions WHERE kind='claim' AND record_id IN (SELECT id FROM prune_claims)`);
  // Re-project the touched connections: their edge survives only if another live claim backs it.
  const remove = db.query("DELETE FROM edges WHERE source_entity_id=? AND target_entity_id=? AND relation=?");
  for (const t of triples) remove.run(t.s, t.o, t.p);
  return list.length;
}

/** Remove entities (and events) after deleting every claim that mentions them. */
function deleteEntities(list: number[]) {
  if (!list.length) return 0;
  db.run("DELETE FROM prune_entities");
  const insert = db.query("INSERT OR IGNORE INTO prune_entities VALUES(?)");
  for (const id of list) insert.run(id);
  deleteClaims(claimIds(`SELECT id FROM graph_claims WHERE subject_id IN (SELECT id FROM prune_entities) OR object_id IN (SELECT id FROM prune_entities)
    UNION SELECT claim_id FROM graph_participants WHERE event_id IN (SELECT id FROM prune_entities) OR entity_id IN (SELECT id FROM prune_entities)
    UNION SELECT claim_id FROM graph_events WHERE entity_id IN (SELECT id FROM prune_entities) AND claim_id IS NOT NULL`));
  db.run(`DELETE FROM graph_participants WHERE event_id IN (SELECT id FROM prune_entities) OR entity_id IN (SELECT id FROM prune_entities)`);
  db.run(`DELETE FROM graph_events WHERE entity_id IN (SELECT id FROM prune_entities)`);
  db.run(`DELETE FROM graph_aliases WHERE entity_id IN (SELECT id FROM prune_entities)`);
  db.run(`DELETE FROM chunk_entities WHERE entity_id IN (SELECT id FROM prune_entities)`);
  db.run(`DELETE FROM edges WHERE source_entity_id IN (SELECT id FROM prune_entities) OR target_entity_id IN (SELECT id FROM prune_entities)`);
  db.run(`DELETE FROM graph_identity_changes WHERE entity_id IN (SELECT id FROM prune_entities) OR canonical_id IN (SELECT id FROM prune_entities)`);
  db.run(`UPDATE entities SET canonical_id=NULL WHERE canonical_id IN (SELECT id FROM prune_entities)`);
  db.run(`DELETE FROM entities WHERE id IN (SELECT id FROM prune_entities)`);
  db.run(`DELETE FROM graph_record_versions WHERE kind IN ('entity','event') AND record_id IN (SELECT CAST(id AS TEXT) FROM prune_entities)`);
  return list.length;
}

/** Step 1: merge WebPage variants that share a canonical URL; the canonical identity becomes the root. */
function mergeWebPages() {
  const groups = new Map<string, Array<{ id: number; key: string; claims: number }>>();
  for (const e of db.query<{ id: number; name: string; namespace: string }, []>(
    "SELECT id,name,namespace FROM entities WHERE type='WebPage' AND canonical_id IS NULL").all()) {
    const key = keyOf(e.id, e.name);
    if (!/^https?:/i.test(key)) continue;
    const canonical = canonicalUrl(key);
    const group = `${e.namespace}\u0000${canonical}`;
    const claims = n("SELECT count(*) n FROM graph_claims WHERE subject_id=?", e.id);
    groups.set(group, [...(groups.get(group) ?? []), { id: e.id, key, claims }]);
  }
  let merged = 0, rekeyed = 0;
  const now = Date.now();
  for (const [group, members] of groups) {
    const [namespace, canonical] = group.split("\u0000") as [string, string];
    const stableId = graphIdentity(namespace, "WebPage", canonical);
    members.sort((a, b) => Number(b.key === canonical) - Number(a.key === canonical) || b.claims - a.claims || a.id - b.id);
    const root = members[0]!;
    if (root.key !== canonical) {
      // Future ingestion resolves the canonical URL to this stable identity.
      if (!db.query("SELECT 1 FROM entities WHERE stable_id=?").get(stableId)) {
        db.query("UPDATE entities SET stable_id=? WHERE id=?").run(stableId, root.id);
        rekeyed++;
      }
      db.query("INSERT OR IGNORE INTO graph_aliases VALUES(?,?,?)").run(root.id, canonical, "connector-key");
    }
    for (const member of members.slice(1)) {
      db.query("INSERT INTO graph_identity_changes VALUES(?,?,?,?,?,NULL)")
        .run(crypto.randomUUID(), member.id, root.id, "prune-graph: same canonical URL", now);
      db.query("UPDATE entities SET canonical_id=? WHERE id=?").run(root.id, member.id);
      // Legacy edge consumers do not resolve canonical_id; move their rows to the root.
      db.query(`INSERT OR IGNORE INTO edges(source_entity_id,target_entity_id,relation,weight,metadata)
        SELECT CASE WHEN source_entity_id=?1 THEN ?2 ELSE source_entity_id END,
               CASE WHEN target_entity_id=?1 THEN ?2 ELSE target_entity_id END,relation,weight,metadata
        FROM edges WHERE (source_entity_id=?1 OR target_entity_id=?1) AND source_entity_id!=target_entity_id`).run(member.id, root.id);
      db.query("DELETE FROM edges WHERE source_entity_id=?1 OR target_entity_id=?1").run(member.id);
      db.query("DELETE FROM edges WHERE source_entity_id=?1 AND target_entity_id=?1").run(root.id);
      merged++;
    }
  }
  return { merged, rekeyed };
}

/** The canonical root and every identity merged into it. */
function membersOf(root: number): number[] {
  return ids(`WITH RECURSIVE m(id) AS (SELECT ? UNION SELECT e.id FROM entities e JOIN m ON e.canonical_id=m.id) SELECT id FROM m`, root);
}
function rootOf(id: number): number {
  let current = id;
  for (let i = 0; i < 50; i++) {
    const next = db.query<{ c: number | null }, [number]>("SELECT canonical_id c FROM entities WHERE id=?").get(current)?.c;
    if (next == null) return current;
    current = next;
  }
  return current;
}
/** A page is known when anything other than an inbound DOM link asserted it. */
function isKnownPage(root: number): boolean {
  const group = membersOf(root).join(",");
  return n(`SELECT count(*) n FROM entities e WHERE e.id IN (${group}) AND (
    EXISTS(SELECT 1 FROM graph_claims c WHERE c.subject_id=e.id)
    OR EXISTS(SELECT 1 FROM graph_participants p WHERE p.entity_id=e.id)
    OR EXISTS(SELECT 1 FROM graph_aliases a WHERE a.entity_id=e.id AND a.scope='source-id')
    OR EXISTS(SELECT 1 FROM graph_claims c WHERE c.object_id=e.id AND c.predicate!='REFERENCES'))`) > 0;
}

/** Step 2: DOM links to pages never visited become LINKS_TO values on the linking page. */
function demoteOutboundLinks() {
  const references = db.query<{ id: string; object_id: number; qualifiers: string; subject_id: number }, []>(
    "SELECT id,object_id,qualifiers,subject_id FROM graph_claims WHERE predicate='REFERENCES' AND method='dom'").all();
  const known = new Map<number, boolean>();
  const drop: string[] = [], targets = new Set<number>();
  let converted = 0;
  const copyClaim = db.query(`INSERT OR IGNORE INTO graph_claims(id,namespace,subject_id,predicate,value_json,polarity,context,qualifiers,
      valid_from,valid_to,observed_at,recorded_at,confidence,strength,method,model,extraction_run,status)
    SELECT 'pruned-link:'||id,namespace,subject_id,'LINKS_TO',json_quote(?),polarity,context,qualifiers,
      valid_from,valid_to,observed_at,recorded_at,confidence,strength,method,model,extraction_run,status FROM graph_claims WHERE id=?`);
  const copyEvidence = db.query(`INSERT OR IGNORE INTO graph_evidence(id,claim_id,revision_id,chunk_index,stance,locator,quote,method,model,confidence,created_at)
    SELECT 'pruned-link:'||id,'pruned-link:'||claim_id,revision_id,chunk_index,stance,locator,quote,method,model,confidence,created_at
    FROM graph_evidence WHERE claim_id=?`);
  for (const ref of references) {
    const root = rootOf(ref.object_id);
    if (!known.has(root)) known.set(root, isKnownPage(root));
    if (known.get(root)) continue;
    targets.add(root);
    drop.push(ref.id);
    const anchor = (JSON.parse(ref.qualifiers) as { anchor?: string }).anchor;
    if (isGenericAnchor(anchor)) continue;
    const name = db.query<{ name: string }, [number]>("SELECT name FROM entities WHERE id=?").get(root)!.name;
    copyClaim.run(canonicalUrl(keyOf(root, name)), ref.id);
    copyEvidence.run(ref.id);
    converted++;
  }
  deleteClaims(drop);
  const entities = [...targets].flatMap(membersOf);
  deleteEntities(entities);
  return { demoted: drop.length, keptAsValues: converted, removedPages: entities.length };
}

/** Step 3: favicon and pixel images are page chrome. */
function removeDecorativeImages() {
  return deleteEntities(images().filter((i) => isDecorativeImage({ url: i.url })).map((i) => i.id));
}

/** Step 4: fold each HistoryRecord into the page it referred to. */
function foldHistoryRecords() {
  const records = db.query<{ id: number; page: number | null }, []>(`SELECT e.id,
    (SELECT object_id FROM graph_claims c WHERE c.subject_id=e.id AND c.predicate='REFERS_TO' ORDER BY recorded_at DESC LIMIT 1) page
    FROM entities e WHERE e.type='HistoryRecord'`).all();
  const observations = ids(`SELECT DISTINCT p.event_id id FROM graph_participants p JOIN graph_events g ON g.entity_id=p.event_id
    WHERE g.kind='history_observation'`);
  deleteEntities(observations);
  for (const record of records) {
    if (record.page === null) continue;
    deleteClaims(claimIds("SELECT id FROM graph_claims WHERE subject_id=? AND predicate='REFERS_TO'", record.id));
    db.query("UPDATE graph_claims SET subject_id=? WHERE subject_id=?").run(record.page, record.id);
    db.query("UPDATE graph_claims SET object_id=? WHERE object_id=?").run(record.page, record.id);
    db.query(`INSERT OR IGNORE INTO graph_aliases(entity_id,alias,scope) SELECT ?,alias,scope FROM graph_aliases
      WHERE entity_id=? AND scope IN ('source-id','connector-key')`).run(record.page, record.id);
    db.query("INSERT OR IGNORE INTO chunk_entities(chunk_id,entity_id) SELECT chunk_id,? FROM chunk_entities WHERE entity_id=?").run(record.page, record.id);
  }
  deleteEntities(records.filter((r) => r.page !== null).map((r) => r.id));
  return { folded: records.filter((r) => r.page !== null).length, historyEvents: observations.length };
}

/** Step 5: UI-chrome topics, topics restating their thread label, and domain-only heuristic threads. */
function pruneTopicsAndThreads() {
  const topics = db.query<{ id: number; name: string }, []>(
    "SELECT id,coalesce(display_name,name) name FROM entities WHERE type='Topic'").all();
  const chrome = topics.filter((t) => isUiChromeTopic(t.name)).map((t) => t.id);
  deleteEntities(chrome);
  const duplicates = db.query<{ id: string; topic: string; thread: string }, []>(`SELECT c.id,coalesce(t.display_name,t.name) topic,
    coalesce(s.display_name,s.name) thread FROM graph_claims c JOIN entities t ON t.id=c.object_id JOIN entities s ON s.id=c.subject_id
    WHERE c.predicate='HAS_TOPIC' AND s.type='ResearchThread' AND t.type='Topic'`).all().filter((r) => sameLabel(r.topic, r.thread));
  deleteClaims(duplicates.map((d) => d.id));
  const exploring = ids(`SELECT e.id FROM entities e WHERE e.type='ResearchThread' AND coalesce(e.display_name,e.name) LIKE 'Exploring %'
    AND NOT EXISTS(SELECT 1 FROM graph_claims c WHERE c.subject_id=e.id AND c.method IN ('user','llm'))
    AND NOT EXISTS(SELECT 1 FROM graph_claims c WHERE c.subject_id=e.id AND c.predicate='HAS_TOPIC')`);
  deleteEntities(exploring);
  return { chromeTopics: chrome.length, topicEqualsThread: duplicates.length, exploringThreads: exploring.length };
}

/** Step 6: attention/activation/close events become measurements on their page, as new ingestion records them. */
function collapseActivityEvents() {
  const events = db.query<{ id: number; kind: string; at: number | null; claim: string; page: number | null }, []>(`SELECT g.entity_id id,g.kind,
    g.occurred_from at,g.claim_id claim,(SELECT entity_id FROM graph_participants p WHERE p.event_id=g.entity_id AND p.role='page' LIMIT 1) page
    FROM graph_events g WHERE g.kind IN ('browser_attention','browser_activation','browser_close') AND g.claim_id IS NOT NULL`).all();
  const predicate: Record<string, string> = { browser_attention: "ATTENTION_MS", browser_activation: "ACTIVATED_AT", browser_close: "CLOSED_AT" };
  const value = db.query<{ v: string | null }, [number, string]>(
    "SELECT value_json v FROM graph_claims WHERE subject_id=? AND predicate=? ORDER BY recorded_at DESC LIMIT 1");
  const insert = db.query(`INSERT OR IGNORE INTO graph_claims(id,namespace,subject_id,predicate,value_json,context,qualifiers,observed_at,
      recorded_at,strength,method,model,status)
    SELECT 'pruned-activity:'||?1,namespace,?2,?3,?4,context,?5,observed_at,recorded_at,strength,method,model,status FROM graph_claims WHERE id=?6`);
  const evidence = db.query(`INSERT OR IGNORE INTO graph_evidence(id,claim_id,revision_id,chunk_index,stance,locator,quote,method,model,confidence,created_at)
    SELECT 'pruned-activity:'||id,'pruned-activity:'||?1,revision_id,chunk_index,stance,locator,quote,method,model,confidence,created_at
    FROM graph_evidence WHERE claim_id=?2`);
  let converted = 0;
  for (const event of events) {
    if (event.page === null) continue;
    const measure = event.kind === "browser_attention" ? value.get(event.id, "DURATIONMS")?.v ?? "0" : JSON.stringify(event.at ?? 0);
    const qualifiers: Record<string, unknown> = { observedAt: event.at };
    for (const [key, name] of [["TABID", "tabId"], ["DOCUMENTID", "documentId"], ["ATTENDED", "attended"]] as const) {
      const v = value.get(event.id, key)?.v;
      if (v != null) qualifiers[name] = JSON.parse(v);
    }
    insert.run(event.id, event.page, predicate[event.kind]!, measure, JSON.stringify(qualifiers), event.claim);
    evidence.run(event.id, event.claim);
    converted++;
  }
  deleteEntities(events.filter((e) => e.page !== null).map((e) => e.id));
  return converted;
}

/** Step 7: drop edges no live claim backs (missing edges are not restored; the map reads claims). */
function reprojectEdges() {
  const before = n("SELECT count(*) n FROM edges");
  const stale = db.query<{ s: number; o: number; p: string }, []>(`SELECT source_entity_id s,target_entity_id o,relation p FROM edges e
    WHERE NOT EXISTS(SELECT 1 FROM graph_claims c WHERE c.subject_id=e.source_entity_id AND c.object_id=e.target_entity_id
      AND c.predicate=e.relation AND c.polarity=1 AND c.status IN ${LIVE})`).all();
  const remove = db.query("DELETE FROM edges WHERE source_entity_id=? AND target_entity_id=? AND relation=?");
  for (const e of stale) remove.run(e.s, e.o, e.p);
  return { removed: stale.length, before, after: n("SELECT count(*) n FROM edges") };
}

/** Step 8: pages, images and topics nothing refers to any more. */
function removeOrphans() {
  return deleteEntities(ids(`SELECT e.id FROM entities e WHERE e.type IN ('WebPage','Image','Topic') AND e.canonical_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM entities m WHERE m.canonical_id=e.id)
    AND NOT EXISTS(SELECT 1 FROM graph_claims c WHERE (c.subject_id=e.id OR c.object_id=e.id) AND c.status IN ${LIVE})
    AND NOT EXISTS(SELECT 1 FROM graph_participants p WHERE p.entity_id=e.id)
    AND NOT EXISTS(SELECT 1 FROM graph_aliases a WHERE a.entity_id=e.id AND a.scope='source-id')`));
}

if (apply) {
  const dir = join(dirname(path), "backups");
  mkdirSync(dir, { recursive: true });
  const backup = join(dir, `pre-prune-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
  db.run("VACUUM INTO ?", [backup]);
  console.error(`Backup written to ${backup}`);
}

const before = profile();
const steps: Record<string, unknown> = {};
const rollback = new Error("dry-run");
try {
  db.transaction(() => {
    steps.mergeWebPages = mergeWebPages();
    steps.demoteOutboundLinks = demoteOutboundLinks();
    steps.removeDecorativeImages = removeDecorativeImages();
    steps.foldHistoryRecords = foldHistoryRecords();
    steps.pruneTopicsAndThreads = pruneTopicsAndThreads();
    steps.collapseActivityEvents = collapseActivityEvents();
    steps.reprojectEdges = reprojectEdges();
    steps.removeOrphans = removeOrphans();
    const foreignKeys = db.query("PRAGMA foreign_key_check").all();
    if (foreignKeys.length) throw new Error(`Foreign key violations: ${JSON.stringify(foreignKeys.slice(0, 5))}`);
    steps.after = profile();
    if (!apply) throw rollback;
  })();
} catch (error) {
  if (error !== rollback) throw error;
}
console.log(JSON.stringify({ path, mode: apply ? "apply" : "dry-run", before, steps }, null, 2));
db.close();
