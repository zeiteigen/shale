import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createExtensionSDK, SourceGraph, type ShaleSDK } from "../sdk";
import { closeScopedSDKs, createScopedSDK } from "../sdk/access";
import { sourceContentHash, type SourceContent } from "../lib/access/source-hash";
import { createTestDatabase } from "./fixtures/database";
import { startMcpServer, type RunningMcpServer } from "../mcp";
import { classifyText, classifySource } from "../lib/access/heuristics";
import { setLabel } from "../lib/access/schema";
import { PASSTHROUGH_TABLES, virtualTableStorage } from "../lib/access/scoped-database";
import { createToken, profileForRequest } from "../lib/access/tokens";
import { readAccessPolicy, validateAccessPolicy, writeAccessPolicy } from "../lib/access/policy";
import { WRITE_REFERENCES } from "../lib/access/write-guard";
import { ChatStore } from "../sdk/chat/store";

const directory = mkdtempSync(join(tmpdir(), "shale-access-"));
const policyPath = process.env.SHALE_ACCESS_PATH!;
let db: Database;
let sdk: ShaleSDK;
let ids: Record<string, number>;
const servers: RunningMcpServer[] = [];
const clients: Client[] = [];
let counter = 0;

const POLICY = {
  defaultTier: "personal",
  unauthenticatedProfile: "local",
  originTiers: { discord: "private" },
  tierRules: [{ match: { uri: "*/vault/journal/*" }, tier: "private" }],
  profiles: {
    local: { clearance: "secret" },
    cloud: { clearance: "personal", deny: [{ origin: "browser" }] },
    reader: { clearance: "personal", write: false },
    fullreader: { clearance: "secret", write: false },
  },
};

function ingest(id: string, origin: string, uri: string, text: string) {
  sdk.ingest.sourceAndChunks({ source: { id, uri, title: id, origin, type: "note", hash: `${id}-v1` }, chunks: [{ text_content: text }] });
  return new SourceGraph(sdk.database, sdk.graph, id, "knowledge");
}

beforeEach(() => {
  writeFileSync(policyPath, JSON.stringify(POLICY));
  db = createTestDatabase(join(directory, `graph-${counter++}.db`));
  sdk = createExtensionSDK("access-test", { database: db, namespace: "knowledge" });
  const notes = ingest("note-cedar", "obsidian", "file:///vault/cedar.md", "Project Cedar kickoff with Bob about the retrieval roadmap.");
  const cedar = notes.entity("cedar", "Project Cedar", "Project");
  const bob = notes.entity("bob", "Bob", "Person");
  notes.link(bob, "WORKS_ON", cedar);
  const dm = ingest("dm-alice", "discord", "discord://channel/1", "Alice said her retrieval diagnosis came back and Bob drove her home.");
  const alice = dm.entity("alice", "Alice", "Person");
  const bobInDm = dm.entity("bob", "Bob", "Person");
  dm.link(bobInDm, "FRIEND_OF", alice);
  ingest("web-history", "browser", "https://example.com/retrieval", "Browsing history about retrieval engines.");
  ingest("keys", "obsidian", "file:///vault/keys.md", "retrieval service password: hunter2-correct-horse");
  ingest("journal", "obsidian", "file:///vault/journal/monday.md", "Journal entry about retrieval anxiety.");
  const plan = notes.entity("plan", "Cedar Codename", "Project");
  notes.link(plan, "PART_OF", cedar);
  setLabel(db, "entity", String(plan), "manual", 3, { reason: "test" });
  ids = { cedar, bob, alice, plan };
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) await server.close().catch(() => {});
  closeScopedSDKs();
  db.close();
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

describe("access heuristics", () => {
  it("marks credentials and card numbers as hard secrets", () => {
    expect(classifyText("deploy with sk-proj-abcdefghijklmnopqrstuvwxyz123456")).toMatchObject({ tier: 3, hard: true });
    expect(classifyText("card 4111 1111 1111 1111 exp 04/29")).toMatchObject({ tier: 3, hard: true });
    expect(classifyText("order 1234 5678 9012 3456")).toMatchObject({ tier: 0 });
  });

  it("raises sensitive topics, contact details, and private services softly", () => {
    expect(classifyText("Diagnosed with anxiety; new medication next week.")).toMatchObject({ tier: 2, hard: false });
    expect(classifyText("Call me at 555-123-4567")).toMatchObject({ tier: 1 });
    expect(classifyText("A recipe for bread")).toMatchObject({ tier: 0 });
    expect(classifySource({ title: "Inbox", uri: "https://mail.google.com/mail/u/0", origin: "browser", type: "page", text: "" }).tier).toBe(2);
  });
});

describe("access policy", () => {
  it("creates the default policy on first read and validates edits", () => {
    rmSync(policyPath);
    const policy = readAccessPolicy();
    expect(Object.keys(policy.profiles)).toEqual(["local", "cloud"]);
    expect(JSON.parse(readFileSync(policyPath, "utf8")).profiles.cloud.clearance).toBe("personal");
    expect(() => validateAccessPolicy({ ...POLICY, profiles: { x: { clearance: "top" } } })).toThrow("clearance");
    expect(() => validateAccessPolicy({ ...POLICY, unauthenticatedProfile: "missing" })).toThrow("unauthenticatedProfile");
  });

  it("maps tokens to profiles and can require one", () => {
    const { token } = createToken("cloud", "laptop");
    expect(profileForRequest(`Bearer ${token}`)).toBe("cloud");
    expect(profileForRequest(undefined)).toBe("local");
    expect(() => profileForRequest("Bearer nope")).toThrow("Invalid");
    writeAccessPolicy({ ...POLICY, unauthenticatedProfile: null });
    expect(() => profileForRequest(undefined)).toThrow("required");
  });
});

describe("scoped database", () => {
  it("keeps email private with an older policy and hides its raw connector tables", () => {
    ingest("email-update", "email", "email://thread/1", "Project Cedar update.");
    const store = new ChatStore(db, sdk.extensionId, "email");
    store.ingest({ conversationId: "thread", title: "Update", kind: "thread", uri: "email://thread/1" },
      [{ messageId: "one", authorId: "alice", authorName: "Alice", sentAt: 1, text: "Private mail", attachments: [] }]);
    const { read } = createScopedSDK("cloud", sdk);
    const source = db.query<SourceContent, []>("SELECT id,hash,title,uri,origin,type FROM sources WHERE id='email-update'").get()!;
    // The model cannot declassify mail automatically, even before an existing policy adds an email origin floor.
    setLabel(db, "source", "email-update", "llm", 0, { contentHash: sourceContentHash(source), reason: "test declassification" });
    expect(read.context.getSource("email-update")).toBeNull();
    expect(read.database.query("SELECT count(*) AS n FROM email_messages").get()).toEqual({ n: 0 });
    expect(read.database.query("SELECT count(*) AS n FROM email_conversations").get()).toEqual({ n: 0 });
    expect(read.database.query("SELECT count(*) AS n FROM email_windows").get()).toEqual({ n: 0 });
  });

  it("hides sources by tier, origin floor, rules, and deny lists, along with their derived records", () => {
    const { read } = createScopedSDK("cloud", sdk);
    const visible = read.database.query<{ id: string }, []>("SELECT id FROM sources ORDER BY id").all().map(r => r.id);
    expect(visible).toEqual(["note-cedar"]);
    expect(read.memory.search({ query: "retrieval" }).hits.map(h => h.sourceId)).toEqual(["note-cedar"]);
    expect(read.graph.entities.resolve("Alice")).toEqual([]);
    expect(read.graph.entities.resolve("Cedar Codename")).toEqual([]);
    expect(read.graph.entities.resolve("Bob")).toHaveLength(1);
    const traversal = read.graph.query.traverse({ start: ids.bob, maxDepth: 3, maxNodes: 50, maxClaims: 50 });
    expect(traversal.claims.map(c => c.predicate)).toEqual(["WORKS_ON"]);
    expect(read.database.query(`SELECT DISTINCT r.source_id FROM graph_revision_chunks c
      JOIN graph_source_revisions r ON r.id=c.revision_id`).all()).toEqual([{ source_id: "note-cedar" }]);
    expect(read.database.query("SELECT count(*) AS n FROM edges").get()).toEqual({ n: 1 });
    expect(read.database.query("SELECT count(*) AS n FROM extension_state").get()).toEqual({ n: 0 });

    const local = createScopedSDK("local", sdk);
    expect(local.read).toBe(sdk);
  });

  it("shadows every main table and view except content-free passthroughs", () => {
    db.run("CREATE TABLE extension_private_cache(id INTEGER PRIMARY KEY, body TEXT)");
    db.run("INSERT INTO extension_private_cache(body) VALUES('secret')");
    const { read } = createScopedSDK("cloud", sdk);
    const main = read.database.query<{ name: string }, []>(
      "SELECT name FROM main.sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
    const shadowed = new Set(read.database.query<{ name: string }, []>("SELECT name FROM sqlite_temp_master WHERE type='view'").all().map(r => r.name));
    const storage = virtualTableStorage(read.database);
    expect(main.filter(name => !shadowed.has(name) && !PASSTHROUGH_TABLES.has(name) && !storage.has(name))).toEqual([]);
    expect(read.database.query("SELECT count(*) AS n FROM extension_private_cache").get()).toEqual({ n: 0 });
  });

  it("keeps full-text search joined to filtered chunks", () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
    });
    for (const file of [...files(join(import.meta.dir, "../sdk")), ...files(join(import.meta.dir, "../mcp"))]) {
      for (const match of readFileSync(file, "utf8").matchAll(/FROM\s+chunks_fts\b[\s\S]{0,120}/g))
        expect(match[0], file).toMatch(/JOIN\s+chunks\s+c\s+ON\s+c\.id\s*=\s*chunks_fts\.rowid/);
    }
  });

  it("cannot write, and picks up new labels and policy edits on refresh", () => {
    const access = createScopedSDK("cloud", sdk);
    expect(() => access.read.database.run("DELETE FROM main.sources")).toThrow();
    setLabel(db, "entity", String(ids.bob), "manual", 2);
    access.refresh();
    expect(access.read.graph.entities.resolve("Bob")).toEqual([]);
    writeAccessPolicy({ ...POLICY, profiles: { ...POLICY.profiles, cloud: { clearance: "private" } } });
    access.refresh();
    expect(access.read.database.query("SELECT count(*) AS n FROM sources").get()).toEqual({ n: 4 });
  });

  it("lets LLM labels refine soft heuristics but never lower hard findings", () => {
    const access = createScopedSDK("cloud", sdk);
    access.refresh();
    const hash = (id: string) => sourceContentHash(db.query<SourceContent, [string]>("SELECT * FROM sources WHERE id=?").get(id)!);
    setLabel(db, "source", "keys", "llm", 0, { contentHash: hash("keys") });
    access.refresh();
    expect(access.scoped!.isVisible("sources", "keys")).toBe(false);
    setLabel(db, "source", "keys", "manual", 1);
    access.refresh();
    expect(access.scoped!.isVisible("sources", "keys")).toBe(true);
  });

  it("classifies displayed entity names and invalidates labels on rename", () => {
    const secretName = "password: regression-fake-password";
    const secret = sdk.graph.entities.create({ name: secretName, type: "Thing" });
    const ordinary = sdk.graph.entities.create({ name: "Ordinary", type: "Thing" });
    const access = createScopedSDK("cloud", sdk);
    expect(access.read.graph.entities.resolve(secretName)).toEqual([]);
    expect(access.read.graph.entities.resolve("Ordinary")).toHaveLength(1);
    sdk.graph.entities.rename(ordinary.id, secretName);
    access.refresh();
    expect(access.scoped!.isVisible("entities", ordinary.id)).toBe(false);
    expect(db.query("SELECT tier,hard FROM graph_access_labels WHERE kind='entity' AND record_id=? AND origin='heuristic'")
      .get(String(secret.id))).toEqual({ tier: 3, hard: 1 });
  });

  it("keeps secret historical passages hidden after the current source becomes benign", () => {
    const access = createScopedSDK("cloud", sdk);
    const old = db.query<{ id: number }, []>("SELECT id FROM graph_source_revisions WHERE source_id='keys'").get()!;
    expect(access.scoped!.isVisible("revisions", old.id)).toBe(false);
    sdk.ingest.sourceAndChunks({ source: { id: "keys", uri: "file:///vault/keys.md", title: "keys", origin: "obsidian", type: "note", hash: "keys-v2" },
      chunks: [{ text_content: "A harmless project overview." }] });
    access.refresh();
    expect(access.scoped!.isVisible("sources", "keys")).toBe(true);
    expect(() => access.read.graph.evidence.revision(old.id)).toThrow("Unknown source revision");
    expect(access.read.database.query("SELECT text_content FROM graph_revision_chunks WHERE revision_id=?").all(old.id)).toEqual([]);
    expect(access.read.database.query("SELECT text_content FROM graph_memory_texts WHERE text_content LIKE '%hunter2%'").all()).toEqual([]);
    expect(sdk.graph.evidence.revision(old.id).chunks.length).toBeGreaterThan(0);
    // New retained passages in an existing revision invalidate its previous verdict.
    const current = db.query<{ id: number }, []>("SELECT r.id FROM graph_source_revisions r JOIN sources s ON s.id=r.source_id AND s.hash=r.hash WHERE s.id='keys'").get()!;
    db.query("INSERT INTO graph_revision_chunks(revision_id,chunk_index,chunk_type,text_content) VALUES(?,99,'verbatim',?)")
      .run(current.id, "password: new-retained-secret");
    access.refresh();
    expect(access.scoped!.isVisible("revisions", current.id)).toBe(false);
    expect(access.scoped!.isVisible("sources", "keys")).toBe(false);
    expect(access.read.database.query("SELECT id FROM graph_source_revisions WHERE source_id='keys'").all()).toEqual([]);
  });

  it("reclassifies metadata-only edits and keeps removed sources classified", async () => {
    const access = createScopedSDK("cloud", sdk);
    await sdk.knowledge.mutate("update_source", { sourceId: "note-cedar", title: "password: archived-secret" },
      { actor: "test", reason: "rename" });
    access.refresh();
    expect(access.scoped!.isVisible("sources", "note-cedar")).toBe(false);
    await sdk.knowledge.mutate("remove_source", { sourceId: "note-cedar" }, { actor: "test", reason: "remove" });
    access.refresh();
    expect(access.scoped!.isVisible("archives", "note-cedar")).toBe(false);
    await expect(access.read.knowledge.read("inspect_source", { sourceId: "note-cedar" })).rejects.toThrow("Unknown removed source");
    await sdk.knowledge.mutate("remove_source", { sourceId: "web-history" }, { actor: "test", reason: "remove" });
    const reader = createScopedSDK("reader", sdk);
    expect(reader.scoped!.isVisible("archives", "web-history")).toBe(true);
  });

  it("hides earlier benign revisions when a source's active memory fails classification", () => {
    const access = createScopedSDK("cloud", sdk);
    const old = db.query<{ id: number }, []>("SELECT id FROM graph_source_revisions WHERE source_id='note-cedar'").get()!;
    sdk.ingest.sourceAndChunks({ source: { id: "note-cedar", uri: "file:///vault/cedar.md", title: "Cedar", origin: "obsidian", type: "note", hash: "cedar-v2" },
      chunks: [{ text_content: "Another ordinary overview." }] });
    access.refresh();
    expect(access.scoped!.isVisible("revisions", old.id)).toBe(true);
    const current = db.query<{ id: number }, []>("SELECT r.id FROM graph_source_revisions r JOIN sources s ON s.id=r.source_id AND s.hash=r.hash WHERE s.id='note-cedar'").get()!;
    db.query("INSERT INTO graph_revision_chunks(revision_id,chunk_index,chunk_type,text_content) VALUES(?,99,'verbatim',?)")
      .run(current.id, "password: retained-secret");
    access.refresh();
    expect(access.scoped!.isVisible("sources", "note-cedar")).toBe(false);
    expect(access.scoped!.isVisible("revisions", old.id)).toBe(false);
  });
});

async function connect(server: RunningMcpServer, token?: string) {
  const client = new Client({ name: "access-test", version: "1.0.0" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`),
    token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : undefined));
  const call = async (name: string, args: Record<string, unknown>) => {
    const response: any = await client.callTool({ name, arguments: args });
    return { error: response.isError === true, data: response.isError ? response.content[0].text : JSON.parse(response.content[0].text) };
  };
  return { client, call };
}

describe("MCP access profiles", () => {
  async function server() {
    const running = await startMcpServer({ port: 0, host: "127.0.0.1", sdk, namespace: "knowledge" });
    servers.push(running);
    return running;
  }

  it("authenticates requests and binds sessions to their profile", async () => {
    const running = await server();
    const denied = await fetch(`${running.url}/mcp`, { method: "POST", headers: { Authorization: "Bearer wrong", "Content-Type": "application/json" }, body: "{}" });
    expect(denied.status).toBe(401);
    const { token } = createToken("cloud");
    const cloud = await connect(running, token);
    const local = await connect(running);
    expect((await cloud.call("search_graph", { query: "retrieval" })).data.hits.map((h: any) => h.sourceId)).toEqual(["note-cedar"]);
    expect((await local.call("search_graph", { query: "retrieval" })).data.totalSources).toBe(5);
    expect((await cloud.call("get_graph_stats", {})).data.entitiesCount).toBe(2);
    expect((await cloud.call("resolve_entities", { name: "Alice" })).data.count).toBe(0);
    expect((await cloud.call("get_source_memory", { sourceId: "dm-alice" })).error).toBe(true);
    const sessionId = (cloud.client.transport as StreamableHTTPClientTransport).sessionId!;
    const hijack = await fetch(`${running.url}/mcp`, { method: "POST", headers: { "mcp-session-id": sessionId,
      "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }) });
    expect(hijack.status).toBe(403);
  });

  it("allows writes only on visible records and attributes them to the profile", async () => {
    const running = await server();
    const { token } = createToken("cloud");
    const cloud = await connect(running, token);
    const claims = () => db.query<{ n: number }, []>("SELECT count(*) AS n FROM graph_claims").get()!.n;
    const before = claims();
    const hidden = await cloud.call("add_claim", { subject: "Bob", predicate: "KNOWS", object: "Alice", reason: "test" });
    expect(hidden.error).toBe(true);
    expect(hidden.data).toContain("not found or outside");
    expect((await cloud.call("add_claim", { subject: ids.alice, predicate: "KNOWS", object: ids.bob, reason: "test" })).error).toBe(true);
    const hiddenClaim = db.query<{ id: string }, []>("SELECT id FROM graph_claims WHERE predicate='FRIEND_OF'").get()!.id;
    expect((await cloud.call("review_claim", { claimId: hiddenClaim, status: "rejected", reason: "test" })).error).toBe(true);
    expect((await cloud.call("rename_entity", { id: ids.plan, name: "Leaked", reason: "test" })).error).toBe(true);
    expect(claims()).toBe(before);

    const ok = await cloud.call("add_claim", { subject: "Bob", predicate: "MENTORS", object: "Project Cedar", reason: "test" });
    expect(ok.error).toBe(false);
    expect(claims()).toBe(before + 1);
    const change = db.query<{ actor: string }, []>("SELECT actor FROM graph_changes ORDER BY created_at DESC LIMIT 1").get()!;
    expect(change.actor).toBe("profile:cloud/mcp-agent");
    const applied = await cloud.call("apply_graph_changes", { reason: "test", operations: [
      { type: "connect_entities", args: { subject: ids.bob, predicate: "LEADS", object: ids.cedar } }] });
    expect(applied.error).toBe(false);
    expect(applied.data.operations[0].before).toBeUndefined();
    const blocked = await cloud.call("apply_graph_changes", { reason: "test", operations: [
      { type: "connect_entities", args: { subject: ids.bob, predicate: "LEADS", object: ids.cedar } },
      { type: "connect_entities", args: { subject: ids.bob, predicate: "KNOWS", object: ids.alice } }] });
    expect(blocked.error).toBe(true);
    expect(claims()).toBe(before + 2);
    // Created records are classified inside the transaction; one above the profile's clearance rolls back.
    const secret = await cloud.call("add_claim", { subject: ids.bob, predicate: "NOTE", value: "password: hunter2-correct-horse", reason: "test" });
    expect(secret.error).toBe(true);
    expect(secret.data).toContain("rolled back");
    const preview = await cloud.call("preview_graph_changes", { reason: "test", operations: [
      { type: "connect_entities", args: { subject: ids.bob, predicate: "NOTE", value: "password: hunter2-correct-horse" } }] });
    expect(preview.error).toBe(true);
    expect(claims()).toBe(before + 2);
  });

  it("omits editing tools for read-only profiles", async () => {
    const running = await server();
    const { token } = createToken("reader");
    const reader = await connect(running, token);
    const tools = (await reader.client.listTools()).tools.map(t => t.name);
    expect(tools).toContain("search_graph");
    expect(tools).not.toContain("add_claim");
    expect(tools).not.toContain("apply_graph_changes");
    expect(tools).not.toContain("edit_source_memory");
    const local = await connect(running);
    const all = (await local.client.listTools()).tools;
    for (const tool of all.filter(t => !t.annotations?.readOnlyHint || t.name === "preview_graph_changes"))
      expect(WRITE_REFERENCES[tool.name], tool.name).toBeDefined();
  });

  it("enforces read-only permissions at secret clearance and after policy edits", async () => {
    const running = await server();
    const { token } = createToken("fullreader");
    const reader = await connect(running, token);
    const tools = (await reader.client.listTools()).tools;
    expect(tools.some(t => !t.annotations?.readOnlyHint || t.name === "preview_graph_changes")).toBe(false);
    expect((await reader.call("create_entity", { name: "Blocked", reason: "test" })).error).toBe(true);
    const local = await connect(running);
    writeAccessPolicy({ ...POLICY, profiles: { ...POLICY.profiles, local: { clearance: "secret", write: false } } });
    expect((await local.call("create_entity", { name: "Blocked", reason: "test" })).error).toBe(true);
    expect(sdk.graph.entities.resolve("Blocked")).toEqual([]);
  });

  it("filters nested inspection receipts, previews and replayed writes", async () => {
    const parent = sdk.graph.claims.add({ subject: ids.bob, predicate: "NOTE", value: "parent", status: "accepted" });
    const child = sdk.graph.claims.add({ subject: ids.bob, predicate: "NOTE", value: "child", status: "accepted", dependsOn: [parent.id], evidence: [
      { sourceId: "note-cedar" }, { sourceId: "keys", chunkIndex: 0, quote: "hunter2-correct-horse" },
    ] });
    const hidden = sdk.graph.claims.add({ subject: ids.bob, predicate: "NOTE", value: "password: hidden-claim", status: "accepted", dependsOn: [child.id] });
    sdk.graph.lifecycle.link(child.id, hidden.id, "supports");
    const running = await server();
    const { token } = createToken("cloud");
    const cloud = await connect(running, token);
    const args = { reason: "test", requestId: "redaction-retry", operations: [{ type: "remove_claim_dependency", args: { claimId: child.id, dependsOn: parent.id } }] };
    const preview = await cloud.call("preview_graph_changes", args);
    const applied = await cloud.call("apply_graph_changes", args);
    const replay = await cloud.call("apply_graph_changes", args);
    for (const receipt of [preview, applied, replay]) {
      expect(receipt.error).toBe(false);
      const result = receipt.data.operations[0].result;
      expect(result.evidence.map((e: any) => e.sourceId)).toEqual(["note-cedar"]);
      expect(result.links).toEqual([]);
      expect(result.dependents).toEqual([]);
      expect(JSON.stringify(receipt.data)).not.toContain("hunter2");
      expect(JSON.stringify(receipt.data)).not.toContain(hidden.id);
    }
    const newPreview = await cloud.call("preview_graph_changes", { reason: "test", operations: [{ type: "append_graph", args: { entities: [{ ref: "new", name: "Preview node", type: "Thing" }] } }] });
    expect(newPreview.error).toBe(false);
    expect(newPreview.data.operations[0].result.entities[0].name).toBe("Preview node");
    expect(sdk.graph.entities.resolve("Preview node")).toEqual([]);
  });

  it("classifies every created record when a guarded batch exceeds one classification page", async () => {
    const cloud = createScopedSDK("cloud", sdk);
    const entities = Array.from({ length: 205 }, (_, index) => ({ ref: `entity${index}`, name: `Batch entity ${index}`, type: "Thing" }));
    await cloud.write.knowledge.apply({ actor: "test", reason: "bulk create", operations: [
      { type: "append_graph", args: { entities: entities.slice(0, 200) } },
      { type: "append_graph", args: { entities: entities.slice(200) } },
    ] });
    cloud.refresh();
    expect(cloud.read.graph.entities.resolve("Batch entity 204")).toHaveLength(1);
  });
});

describe("access-classifier extension", () => {
  it("refines heuristic tiers with model verdicts and retries failures a bounded number of times", async () => {
    const { run } = await import("../extensions/access-classifier/index");
    const prompts: string[] = [];
    sdk.queryLLM = (async (prompt: string) => {
      prompts.push(prompt);
      if (prompt.includes("note-cedar")) return JSON.stringify({ source: { tier: "public", reason: "work note" },
        entities: [{ id: ids.bob, tier: "private", reason: "named individual" }], claims: [] });
      return "not json";
    }) as ShaleSDK["queryLLM"];
    const result = await run(sdk);
    expect(result.llm).toBe(1);
    expect(prompts.length).toBe(5);
    expect(prompts.find(p => p.includes("note-cedar"))).toContain("Bob (Person)");
    const label = db.query<{ tier: number }, []>(`SELECT tier FROM graph_access_labels WHERE kind='entity' AND record_id='${ids.bob}' AND origin='llm'`).get();
    expect(label?.tier).toBe(2);
    const access = createScopedSDK("cloud", sdk);
    expect(access.read.graph.entities.resolve("Bob")).toEqual([]);
    expect(access.scoped!.isVisible("sources", "note-cedar")).toBe(true);
    await run(sdk);
    await run(sdk);
    prompts.length = 0;
    await run(sdk);
    expect(prompts.length).toBe(0);
  });

  it("does not attach an old model verdict to an entity renamed while classification runs", async () => {
    const { run } = await import("../extensions/access-classifier/index");
    sdk.queryLLM = (async (prompt: string) => {
      if (!prompt.includes("note-cedar")) return "not json";
      sdk.graph.entities.rename(ids.bob, "Diagnosed with anxiety; prescribed medication");
      return JSON.stringify({ source: { tier: "personal" }, entities: [{ id: ids.bob, tier: "public" }] });
    }) as ShaleSDK["queryLLM"];
    await run(sdk);
    const access = createScopedSDK("cloud", sdk);
    expect(access.scoped!.isVisible("entities", ids.bob)).toBe(false);
    expect(db.query("SELECT 1 FROM graph_access_labels WHERE kind='entity' AND record_id=? AND origin='llm'").get(String(ids.bob))).toBeNull();
  });

  it("ignores a model verdict after the source metadata changes while classification runs", async () => {
    const { run } = await import("../extensions/access-classifier/index");
    sdk.queryLLM = (async (prompt: string) => {
      if (!prompt.includes("note-cedar")) return "not json";
      await sdk.knowledge.mutate("update_source", { sourceId: "note-cedar", title: "Diagnosed with anxiety; prescribed medication" },
        { actor: "test", reason: "rename during classification" });
      return JSON.stringify({ source: { tier: "public" } });
    }) as ShaleSDK["queryLLM"];
    await run(sdk);
    const access = createScopedSDK("cloud", sdk);
    expect(access.scoped!.isVisible("sources", "note-cedar")).toBe(false);
  });
});

describe("access web API", () => {
  it("edits the policy, record tiers, and tokens, and previews each profile", async () => {
    const { accessApi } = await import("../main/access-api");
    const call = async (method: string, path: string, body?: unknown) => {
      const url = new URL(`http://localhost${path}`);
      const response = await accessApi(new Request(url, { method, ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}) }), url, sdk);
      return { status: response!.status, data: await response!.json() as any };
    };
    const overview = await call("GET", "/api/access");
    expect(overview.data.origins.map((o: any) => o.origin).sort()).toEqual(["browser", "discord", "obsidian"]);
    expect((await call("PUT", "/api/access", { policy: { ...POLICY, defaultTier: "nope" } })).status).toBe(400);
    expect((await call("PUT", "/api/access", { policy: { ...POLICY, originTiers: { discord: "personal" } } })).status).toBe(200);
    const preview = await call("GET", "/api/access/preview");
    expect(preview.data.profiles.cloud.origins.map((o: any) => o.origin).sort()).toEqual(["discord", "obsidian"]);
    expect(preview.data.profiles.local.unrestricted).toBe(true);
    const label = await call("PUT", "/api/access/labels", { kind: "source", id: "dm-alice", tier: "secret" });
    expect(label.data.tier).toBe("secret");
    expect(label.data.labels.map((l: any) => l.origin).sort()).toEqual(["heuristic", "manual"]);
    expect((await call("DELETE", "/api/access/labels?kind=source&id=dm-alice")).data.tier).toBe("personal");
    const token = await call("POST", "/api/access/tokens", { profile: "cloud", label: "agent" });
    expect(token.status).toBe(201);
    expect((await call("DELETE", `/api/access/tokens/${token.data.token.id}`)).data.revoked).toBe(true);
  });
});
