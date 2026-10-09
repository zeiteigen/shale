import { Database } from "bun:sqlite";
import { resolve } from "node:path";

/** Read-only integrity and provenance audit for an actual populated Shale graph. */
const path = resolve(process.argv[2] ?? resolve(import.meta.dir, "../data/production.db"));
const db = new Database(path, { readonly: true });
const count = (sql: string) => db.query<{ n: number }, []>(sql).get()!.n;
const issues: Record<string, number> = {};
db.transaction(() => {
  const integrity = db.query("PRAGMA quick_check").all();
  if (JSON.stringify(integrity) !== JSON.stringify([{ quick_check: "ok" }])) issues.integrity = integrity.length;
  const foreignKeys = db.query("PRAGMA foreign_key_check").all();
  if (foreignKeys.length) issues.foreignKeys = foreignKeys.length;
  const checks = {
    emptySources: "SELECT count(*) n FROM sources s WHERE NOT EXISTS(SELECT 1 FROM chunks c WHERE c.source_id=s.id)",
    missingEvidence: "SELECT count(*) n FROM graph_claims c WHERE method NOT IN ('legacy','manual') AND NOT EXISTS(SELECT 1 FROM graph_evidence e WHERE e.claim_id=c.id)",
    missingEvidenceChunks: "SELECT count(*) n FROM graph_evidence e WHERE chunk_index IS NOT NULL AND NOT EXISTS(SELECT 1 FROM graph_revision_chunks c WHERE c.revision_id=e.revision_id AND c.chunk_index=e.chunk_index)",
    missingModelProvenance: "SELECT count(*) n FROM graph_claims WHERE method IN ('llm','vision','document-summary') AND (model IS NULL OR trim(model)='')",
    unreviewedAcceptedModelClaims: "SELECT count(*) n FROM graph_claims c WHERE c.method IN ('llm','vision') AND c.status='accepted' AND NOT EXISTS(SELECT 1 FROM graph_reviews r WHERE r.claim_id=c.id AND r.status='accepted')",
    liveClaimsWithStaleSupport: `SELECT count(*) n FROM graph_claims c WHERE c.status IN ('accepted','proposed','disputed') AND EXISTS(
      SELECT 1 FROM graph_evidence e JOIN graph_source_revisions r ON r.id=e.revision_id
      WHERE e.claim_id=c.id AND e.stance='supports' AND NOT EXISTS(SELECT 1 FROM sources s WHERE s.id=r.source_id AND s.hash=r.hash))`,
  };
  for (const [name, sql] of Object.entries(checks)) {
    const n = count(sql);
    if (n) issues[name] = n;
  }
  let invalidQuotes = 0;
  const evidence = db.query<{ quote: string; locator: string; text_content: string | null }, []>(`
    SELECT e.quote,e.locator,c.text_content FROM graph_evidence e
    LEFT JOIN graph_revision_chunks c ON c.revision_id=e.revision_id AND c.chunk_index=e.chunk_index WHERE e.quote IS NOT NULL`).all();
  for (const row of evidence) {
    const locator = JSON.parse(row.locator);
    if (!row.text_content?.includes(row.quote) ||
        (locator.start !== undefined && row.text_content.slice(locator.start, locator.end) !== row.quote)) invalidQuotes++;
  }
  if (invalidQuotes) issues.invalidQuotes = invalidQuotes;
  const sources = count("SELECT count(*) n FROM sources");
  if (!sources) issues.emptyGraph = 1;
  console.log(JSON.stringify({ path, at: new Date().toISOString(), sources,
    chunks: count("SELECT count(*) n FROM chunks"),
    entities: count("SELECT count(*) n FROM entities"),
    claims: count("SELECT count(*) n FROM graph_claims"),
    evidence: count("SELECT count(*) n FROM graph_evidence"),
    sourceTypes: db.query("SELECT origin,type,count(*) n FROM sources GROUP BY origin,type").all(),
    claimStatuses: db.query("SELECT status,method,count(*) n FROM graph_claims GROUP BY status,method").all(),
    checkpoints: db.query("SELECT extension_id,count(*) n FROM checkpoints GROUP BY extension_id").all(),
    extractionPending: count(`SELECT count(*) n FROM graph_source_revisions r JOIN sources s ON s.id=r.source_id AND s.hash=r.hash
      WHERE NOT EXISTS(SELECT 1 FROM extension_state p WHERE p.extension_id='knowledge-extractor' AND p.state_key='extracted:'||r.id)`),
    issues,
  }, null, 2));
})();
db.close();
if (Object.keys(issues).length) process.exitCode = 1;
