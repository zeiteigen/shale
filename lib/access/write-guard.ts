import type { Database } from "bun:sqlite";
import type { GraphIngestor } from "../../sdk/graph";
import { classifyPending } from "./classify";
import { readAccessPolicy, resolveProfile } from "./policy";
import type { ScopedDatabase } from "./scoped-database";
import { materializeVisibility, visibleTable, type VisibleSet } from "./visibility";
import { redactReceipt } from "./receipts";

type RefKind = "entity" | "claim" | "source" | "chunk" | "evidence" | "revision" | "identity-change";
type Spec = Array<[path: string, kind: RefKind]>;

const evidenceRefs = (base: string): Spec => [[`${base}.sourceId`, "source"], [`${base}.revisionId`, "revision"]];
const claimRefs = (base: string): Spec => [
  [`${base}.subject`, "entity"], [`${base}.object`, "entity"], [`${base}.dependsOn[]`, "claim"], ...evidenceRefs(`${base}.evidence[]`),
];

/**
 * Every record a write may touch, by tool or operation name. Names missing here are refused,
 * so a new write path cannot bypass the scope check by accident.
 */
export const WRITE_REFERENCES: Record<string, Spec> = {
  // Audited editing operations (sdk/knowledge/schemas.ts)
  update_entity: [["id", "entity"]],
  remove_entity_alias: [["id", "entity"]],
  split_entity: [["id", "entity"], ["entities[].claimIds[]", "claim"], ["entities[].chunkIds[]", "chunk"]],
  connect_entities: claimRefs(""),
  revise_connection: [["claimId", "claim"], ...claimRefs("patch")],
  retract_connection: [["claimId", "claim"]],
  revise_claim: [["claimId", "claim"], ...claimRefs("patch")],
  unlink_claims: [["from", "claim"], ["to", "claim"]],
  add_claim_dependency: [["claimId", "claim"], ["dependsOn", "claim"]],
  remove_claim_dependency: [["claimId", "claim"], ["dependsOn", "claim"]],
  batch_review_claims: [["claims[].claimId", "claim"]],
  revise_evidence: [["evidenceId", "evidence"], ...evidenceRefs("patch")],
  retract_evidence: [["evidenceId", "evidence"]],
  revise_event: [["id", "entity"], ["participants[].entity", "entity"], ...evidenceRefs("participants[].evidence[]")],
  append_graph: claimRefs("claims[]"),
  add_source: [],
  update_source: [["sourceId", "source"]],
  remove_source: [["sourceId", "source"]],
  restore_source: [["sourceId", "source"]],
  add_chunk: [["sourceId", "source"], ["entityIds[]", "entity"], ["claimIds[]", "claim"]],
  revise_chunk: [["sourceId", "source"], ["chunkId", "chunk"], ["entityIds[]", "entity"], ["claimIds[]", "claim"]],
  remove_chunk: [["sourceId", "source"], ["chunkId", "chunk"]],
  // Batches are checked per operation by the knowledge editor.
  apply_graph_changes: [],
  preview_graph_changes: [],
  // Legacy MCP graph tools (mcp/tools/*.ts)
  create_entity: [],
  rename_entity: [["id", "entity"]],
  merge_entities: [["from", "entity"], ["into", "entity"]],
  unmerge_entities: [["changeId", "identity-change"]],
  add_entity_alias: [["id", "entity"]],
  add_claim: claimRefs(""),
  batch_add_claims: claimRefs("claims[]"),
  review_claim: [["claimId", "claim"]],
  link_claims: [["from", "claim"], ["to", "claim"]],
  create_event: [["participants[].entity", "entity"]],
  add_evidence: [["claimId", "claim"], ["sourceId", "source"], ["revisionId", "revision"]],
  define_relation: [],
  // Episode tools (mcp/tools/episodes.ts)
  merge_episodes: [["from", "entity"], ["into", "entity"]],
  detach_from_episode: [["episode", "entity"], ["sourceId", "source"]],
  split_episode: [["episode", "entity"], ["sourceIds[]", "source"]],
  infer_transitive: [],
  // Source memory tools
  edit_source_memory: [["sourceId", "source"]],
  refresh_source: [["sourceId", "source"]],
  repair_source_memory: [["sourceId", "source"], ["claims[].claimId", "claim"]],
  discord_reconcile: [["sourceId", "source"], ["entityIds[]", "entity"], ["claimIds[]", "claim"]],
};

export class AccessScopeError extends Error {
  readonly code = "NOT_FOUND";
}

const notFound = (kind: string, id: unknown) => new AccessScopeError(`Unknown ${kind} ${JSON.stringify(id)} (not found or outside this access profile)`);

/** Visit (and optionally replace) each value at a dotted path where `[]` steps through arrays. */
function visit(value: unknown, path: string[], fn: (value: unknown) => unknown): unknown {
  if (!path.length) return fn(value);
  if (value === null || typeof value !== "object") return value;
  const [head, ...rest] = path;
  if (head!.endsWith("[]")) {
    const key = head!.slice(0, -2);
    const list = key ? (value as Record<string, unknown>)[key] : value;
    if (!Array.isArray(list)) return value;
    const next = list.map(item => visit(item, rest, fn));
    if (!key) return next;
    return { ...(value as object), [key]: next };
  }
  const record = value as Record<string, unknown>;
  if (!(head! in record) || record[head!] === undefined || record[head!] === null) return value;
  return { ...record, [head!]: visit(record[head!], rest, fn) };
}

/** "claims[].subject" → ["claims[]","subject"]; an empty prefix collapses. */
function splitPath(path: string) {
  return path.split(".").filter(Boolean);
}

export interface WriteGuardOptions {
  scoped: ScopedDatabase;
  /** Graph API over the scoped connection, used to resolve entity names among visible entities only. */
  visibleGraph: GraphIngestor;
  writer: Database;
}

/**
 * Restricted profiles write through the shared connection, so every write is checked twice:
 * referenced records must be visible before it runs, and records it creates must be visible
 * after it runs (inside the same transaction, which rolls back on failure). Cascades onto
 * hidden claims (dependents going stale) are allowed but never reported back.
 */
export class AccessWriteGuard {
  private journalStart = 0;
  constructor(private options: WriteGuardOptions) {}

  get profileName() {
    return this.options.scoped.profileName;
  }

  prepare(name: string, args: Record<string, unknown>): Record<string, unknown> {
    const spec = WRITE_REFERENCES[name];
    if (!spec) throw new AccessScopeError(`"${name}" is not available to the "${this.profileName}" access profile`);
    const profile = this.options.scoped.refresh();
    if (profile.write === false) throw new AccessScopeError(`The "${this.profileName}" access profile is read-only`);
    let result: unknown = args;
    for (const [path, kind] of spec) result = visit(result, splitPath(path), value => this.verify(kind, value));
    return result as Record<string, unknown>;
  }

  private verify(kind: RefKind, value: unknown): unknown {
    const scoped = this.options.scoped;
    switch (kind) {
      case "entity": {
        if (typeof value === "string" && value.startsWith("@")) return value;
        if (typeof value === "string" && !/^\d+$/.test(value.trim())) {
          const matches = this.options.visibleGraph.entities.resolve(value.trim());
          if (matches.length === 0) throw notFound("entity", value);
          if (matches.length > 1) throw new AccessScopeError(`Entity ${JSON.stringify(value)} is ambiguous: ${
            matches.map(e => `#${e.id} "${e.name}" (${e.type})`).join(", ")}. Specify the numeric ID.`);
          return matches[0]!.id;
        }
        const id = Number(value);
        if (!scoped.isVisible("entities", id)) throw notFound("entity", value);
        return typeof value === "string" ? id : value;
      }
      case "claim": if (!scoped.isVisible("claims", String(value))) throw notFound("claim", value); return value;
      case "source":
        if (!scoped.isVisible("sources", String(value)) && !scoped.isVisible("archives", String(value))) throw notFound("source", value);
        return value;
      case "chunk": if (!scoped.isVisible("chunks", Number(value))) throw notFound("chunk", value); return value;
      case "evidence": if (!scoped.isVisible("evidence", String(value))) throw notFound("evidence", value); return value;
      case "revision": if (!scoped.isVisible("revisions", Number(value))) throw notFound("revision", value); return value;
      case "identity-change":
        if (!scoped.db.query("SELECT 1 FROM graph_identity_changes WHERE id=?").get(String(value))) throw notFound("change", value);
        return value;
    }
  }

  /** Called inside the write transaction once the knowledge journal is active. */
  begin() {
    this.journalStart = this.options.writer.query<{ n: number }, []>("SELECT coalesce(max(rowid),0) AS n FROM knowledge_edit_journal").get()!.n;
  }

  /** Called inside the write transaction after the work; throws (rolling back) on any out-of-scope effect. */
  check() {
    const writer = this.options.writer;
    const touched = writer.query<{ kind: string; record_id: string; events: string }, [number]>(
      "SELECT kind,record_id,group_concat(event,'') AS events FROM knowledge_edit_journal WHERE rowid>? GROUP BY kind,record_id",
    ).all(this.journalStart);
    const ids = (kind: string) => touched.filter(r => r.kind === kind).map(r => r.record_id);
    classifyPending(writer, { ids: { sources: ids("source"), entities: ids("entity").map(Number), claims: ids("claim") } });
    const policy = readAccessPolicy();
    materializeVisibility(writer, resolveProfile(this.profileName, policy), policy, "access_guard");
    const after = (set: VisibleSet, id: string | number) =>
      Boolean(writer.query(`SELECT 1 FROM ${visibleTable("access_guard", set)} WHERE id=?`).get(id));
    const scoped = this.options.scoped;
    for (const record of touched) {
      const created = record.events.includes("I");
      const exists = (table: string, column = "id") => Boolean(writer.query(`SELECT 1 FROM main.${table} WHERE ${column}=?`).get(record.record_id));
      let before: boolean, visibleAfter: boolean, live: boolean;
      switch (record.kind) {
        case "source":
          before = scoped.isVisible("sources", record.record_id) || scoped.isVisible("archives", record.record_id);
          visibleAfter = after("sources", record.record_id) || after("archives", record.record_id);
          live = exists("sources") || exists("graph_source_archives", "source_id");
          break;
        case "chunk":
          before = scoped.isVisible("chunks", Number(record.record_id));
          visibleAfter = after("chunks", Number(record.record_id));
          live = exists("chunks");
          break;
        case "entity": case "event":
          before = scoped.isVisible("entities", Number(record.record_id));
          visibleAfter = after("entities", Number(record.record_id));
          live = exists("entities");
          break;
        case "claim":
          before = scoped.isVisible("claims", record.record_id);
          visibleAfter = after("claims", record.record_id);
          live = exists("graph_claims");
          break;
        case "evidence":
          before = scoped.isVisible("evidence", record.record_id);
          visibleAfter = after("evidence", record.record_id);
          live = exists("graph_evidence");
          break;
        default:
          continue;
      }
      if (before) continue;
      if (created) {
        if (!live || visibleAfter) continue;
        throw new AccessScopeError(`This change would create a ${record.kind} outside the "${this.profileName}" access profile; it was rolled back`);
      }
      // Dependency invalidation may stale hidden claims; that reveals nothing and is allowed.
      if (record.kind === "claim" && writer.query("SELECT 1 FROM main.graph_claims WHERE id=? AND status='stale'").get(record.record_id)) continue;
      throw new AccessScopeError(`This change affects records outside the "${this.profileName}" access profile; it was rolled back`);
    }
  }

  /** Drop references to records the profile cannot see from a write receipt. */
  redact<T>(result: T): T {
    const writer = this.options.writer;
    // Inside a write/preview, the guard's TEMP sets describe the uncommitted state.
    const active = writer.query<{ active: number }, []>("SELECT active FROM knowledge_edit_session WHERE id=1").get()?.active === 1;
    if (active) return redactReceipt(result, (set, id) =>
      Boolean(writer.query(`SELECT 1 FROM ${visibleTable("access_guard", set)} WHERE id=?`).get(id)));
    this.options.scoped.refresh();
    return redactReceipt(result, (set, id) => this.options.scoped.isVisible(set, id));
  }
}
