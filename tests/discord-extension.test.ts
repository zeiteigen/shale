import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionSDK, createMessageBus, type ShaleSDK } from "../sdk";
import { run } from "../extensions/discord";
import { run as sync } from "../extensions/discord/sync";
import { run as recover } from "../extensions/discord/recover";
import { exporterArgs, parseListing } from "../extensions/discord/dce";
import { summarizeOutput } from "../extensions/discord/dce-runner";
import { parseDiscordExport } from "../extensions/discord/parse-dce";
import { auth } from "../extensions/discord/auth";
import { isTExtensionManifest } from "../lib/extension";
import manifest from "../extensions/discord/manifest.json";
import { createTestDatabase } from "./fixtures/database";

const T0 = Date.UTC(2026, 0, 5, 10, 0);
const iso = (minute: number) => new Date(T0 + minute * 60_000).toISOString();

function dceExport(messages: unknown[], channel = { id: "200", type: "GuildTextChat", name: "general", category: "Text" }) {
  return { guild: { id: "100", name: "Shale Dev" }, channel, dateRange: { after: null, before: null }, messages, messageCount: messages.length };
}

function dceMessage(id: string, minute: number, content: string, author = { id: "1", name: "alice", nickname: "Alice" }, extra: object = {}) {
  return { id, type: "Default", timestamp: iso(minute), timestampEdited: null, isPinned: false, content,
    author: { ...author, discriminator: "0000", isBot: false }, attachments: [], embeds: [], stickers: [], reactions: [], mentions: [], ...extra };
}

let directory: string;
let database: ReturnType<typeof createTestDatabase>;
let sdk: ShaleSDK;
let llmCalls: number;

function configure(settings: Record<string, unknown>) {
  writeFileSync(join(directory, "settings.json"), JSON.stringify({ importDir: join(directory, "import"),
    exportDir: join(directory, "exports"), namespace: "discord", ...settings }));
}

const count = (sql: string) => database.query<{ n: number }, []>(`SELECT count(*) AS n FROM (${sql})`).get()!.n;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "shale-discord-"));
  mkdirSync(join(directory, "import"));
  database = createTestDatabase();
  sdk = createExtensionSDK("discord", { database, messageBus: createMessageBus(), extensionDir: directory });
  sdk.logger.log = () => {};
  sdk.logger.warn = () => {};
  sdk.logger.error = () => {};
  llmCalls = 0;
  sdk.queryLLM = (async () => {
    llmCalls++;
    return JSON.stringify({ title: "Planning the SQLite migration", summary: "Alice and Bob planned the SQLite migration.", topics: ["SQLite", "migrations"] });
  }) as unknown as typeof sdk.queryLLM;
  configure({});
});

afterEach(() => {
  sdk.messages.clear();
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("discord extension", () => {
  it("has an auto-discoverable manifest", () => {
    expect(isTExtensionManifest(manifest)).toBe(true);
  });

  it("parses DiscordChatExporter JSON including replies, embeds, reactions, and system notices", () => {
    const parsed = parseDiscordExport(dceExport([
      dceMessage("10", 0, "hello", undefined, { reactions: [{ emoji: { id: null, name: "👍", code: "thumbsup" }, count: 2, users: [] }],
        attachments: [{ id: "a", url: "https://cdn/x/diagram.png", fileName: "diagram.png", fileSizeBytes: 10 }] }),
      dceMessage("11", 1, "hi!", { id: "2", name: "bob", nickname: null as unknown as string }, { type: "Reply", reference: { messageId: "10", channelId: "200", guildId: "100" },
        embeds: [{ title: "SQLite docs", url: "https://sqlite.org", description: "Small. Fast. Reliable." }] }),
      dceMessage("12", 2, "", undefined, { type: "ChannelPinnedMessage" }),
      { broken: true },
    ]));
    expect(parsed.conversation).toMatchObject({ conversationId: "200", title: "#general", kind: "channel",
      server: { id: "100", name: "Shale Dev", uri: "discord://guild/100" } });
    expect(parsed.skipped).toBe(1);
    expect(parsed.messages[0]).toMatchObject({ authorName: "Alice", reactions: [{ emoji: "👍", count: 2 }],
      attachments: [{ kind: "image", name: "diagram.png" }] });
    expect(parsed.messages[1]).toMatchObject({ authorName: "bob", replyToId: "10", attachments: [{ kind: "embed", name: "SQLite docs" }] });
    expect(parsed.messages[2]!.isSystem).toBe(true);
  });

  it("imports exports into windowed sources with people, conversation, and server in the graph", async () => {
    writeFileSync(join(directory, "import", "general.json"), JSON.stringify(dceExport([
      dceMessage("10", 0, "Should we migrate to SQLite?"),
      dceMessage("11", 2, "Yes, FTS5 would help.", { id: "2", name: "bob", nickname: "Bob" }),
      dceMessage("12", 4, "I'll write the migration."),
      dceMessage("20", 180, "Migration merged."),
    ])));
    const result = await run(sdk);
    expect(result!.indexed.indexed).toBe(2);
    expect(llmCalls).toBe(1); // the one-message window uses the heuristic summary
    const sources = database.query<{ type: string; origin: string; uri: string; title: string }, []>(
      "SELECT type,origin,uri,title FROM sources ORDER BY created_at").all();
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({ type: "chat_session", origin: "discord", uri: "discord://channel/200#window=10",
      title: "Planning the SQLite migration · #general" });
    const text = database.query<{ text: string }, []>("SELECT group_concat(text_content,'\n') AS text FROM chunks").get()!.text;
    expect(text).toContain("Bob: Yes, FTS5 would help.");
    const people = database.query<{ name: string }, []>(
      "SELECT coalesce(display_name,name) AS name FROM entities WHERE type='Person' ORDER BY 1").all().map(r => r.name);
    expect(people).toEqual(["Alice", "Bob"]);
    expect(count("SELECT 1 FROM graph_aliases WHERE scope='external:discord' AND alias IN ('1','2')")).toBe(2);
    expect(count("SELECT 1 FROM entities WHERE type='Server'")).toBe(1);
    expect(count("SELECT 1 FROM entities WHERE type='Topic'")).toBe(2);
    expect(count("SELECT 1 FROM checkpoints")).toBe(0);

    // Unchanged files and windows are skipped on the next run.
    const again = await run(sdk);
    expect(again!.imported).toMatchObject({ files: 0, skipped: 1 });
    expect(again!.indexed.indexed).toBe(0);
    expect(llmCalls).toBe(1);
  });

  it("re-indexes a window in place when a message is edited", async () => {
    const path = join(directory, "import", "general.json");
    const messages = [dceMessage("10", 0, "first"), dceMessage("11", 1, "second"), dceMessage("12", 2, "third")];
    writeFileSync(path, JSON.stringify(dceExport(messages)));
    await run(sdk);
    const before = database.query<{ id: string; hash: string }, []>("SELECT id,hash FROM sources").get()!;
    writeFileSync(path, JSON.stringify(dceExport([messages[0], { ...messages[1], content: "second (edited)", timestampEdited: iso(5) }, messages[2]])));
    await run(sdk);
    const after = database.query<{ id: string; hash: string }, []>("SELECT id,hash FROM sources").all();
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before.id);
    expect(after[0]!.hash).not.toBe(before.hash);
    expect(database.query<{ t: string }, []>("SELECT group_concat(text_content) AS t FROM chunks").get()!.t).toContain("second (edited)");
  });

  it("recovers checkpointed windows without calling the LLM again", async () => {
    writeFileSync(join(directory, "import", "general.json"), JSON.stringify(dceExport([
      dceMessage("10", 0, "a"), dceMessage("11", 1, "b"), dceMessage("12", 2, "c")])));
    const original = sdk.ingest.sourceAndChunks.bind(sdk.ingest);
    sdk.ingest.sourceAndChunks = () => { throw new Error("disk full"); };
    const failed = await run(sdk);
    expect(failed!.indexed.errors).toHaveLength(1);
    expect(count("SELECT 1 FROM checkpoints")).toBe(1);
    sdk.ingest.sourceAndChunks = original;
    sdk.queryLLM = (async () => { throw new Error("LLM must not be called during recovery"); }) as unknown as typeof sdk.queryLLM;
    expect(await recover(sdk)).toEqual({ recoveredWindows: 1 });
    expect(count("SELECT 1 FROM sources")).toBe(1);
    expect(count("SELECT 1 FROM checkpoints")).toBe(0);
  });

  it("refreshes source memory and graph names when only channel metadata changes", async () => {
    configure({ summarize: false });
    const path = join(directory, "import", "general.json");
    const messages = [dceMessage("10", 0, "A project roadmap discussion."), dceMessage("20", 180, "A delivery date discussion.")];
    writeFileSync(path, JSON.stringify(dceExport(messages)));
    await run(sdk);
    const before = database.query<{ id: string; hash: string }, []>("SELECT id,hash FROM sources ORDER BY id").all();
    writeFileSync(path, JSON.stringify(dceExport(messages, { id: "200", type: "GuildTextChat", name: "renamed-channel", category: "Text" })));
    const changed = await run(sdk);
    const after = database.query<{ id: string; hash: string }, []>("SELECT id,hash FROM sources ORDER BY id").all();
    expect(changed!.imported.messages).toBe(0);
    expect(changed!.indexed.indexed).toBe(2);
    expect(after.map(s => s.id)).toEqual(before.map(s => s.id));
    for (const [i, source] of after.entries()) {
      expect(source.hash).not.toBe(before[i]!.hash);
      expect(sdk.memory.get(source.id).summary.text).toContain("#renamed-channel");
      expect(sdk.memory.get(source.id).summary.text).not.toContain("#general");
    }
    expect(sdk.graph.entities.resolve("#renamed-channel")[0]!.name).toBe("#renamed-channel");
    expect((await run(sdk))!.indexed.indexed).toBe(0);
  });

  it("discards checkpoints with old conversation metadata before reindexing", async () => {
    const { discordConnector } = await import("../extensions/discord/connector");
    const connector = discordConnector(sdk);
    const messages = [dceMessage("10", 0, "first"), dceMessage("11", 1, "second"), dceMessage("12", 2, "third")];
    const original = sdk.ingest.sourceAndChunks.bind(sdk.ingest);
    const parsed = parseDiscordExport(dceExport(messages));
    connector.store.ingest(parsed.conversation, parsed.messages);
    sdk.ingest.sourceAndChunks = () => { throw new Error("disk full"); };
    await run(sdk);
    expect(count("SELECT 1 FROM checkpoints")).toBe(1);
    const renamed = parseDiscordExport(dceExport(messages, { id: "200", type: "GuildTextChat", name: "renamed", category: "Text" }));
    connector.store.ingest(renamed.conversation, renamed.messages);
    sdk.ingest.sourceAndChunks = original;
    expect(await recover(sdk)).toEqual({ recoveredWindows: 0 });
    expect(count("SELECT 1 FROM sources")).toBe(0);
    expect(count("SELECT 1 FROM checkpoints")).toBe(0);
    expect((await run(sdk))!.indexed.indexed).toBe(1);
    expect(database.query<{ title: string }, []>("SELECT title FROM sources").get()!.title).toContain("#renamed");
  });

  it("parses exporter listings and builds per-channel export arguments", () => {
    expect(parseListing("0                   | Direct Messages\n1306680826402050048 | Shale Dev\n  * 42 | Thread / ideas\nExporting...\n"))
      .toEqual([{ id: "1306680826402050048", name: "Shale Dev" }, { id: "42", name: "Thread / ideas" }]);
    expect(exporterArgs("200", "/out", { includeThreads: "active", initialSyncDays: 1 }, null, T0)).toEqual(
      ["export", "-c", "200", "-f", "Json", "-o", "/out/%c.json", "--include-threads", "Active", "--after", new Date(T0 - 86_400_000).toISOString()]);
    // Full history by default; a watermark always wins.
    expect(exporterArgs("200", "/out", {}, null)).toEqual(["export", "-c", "200", "-f", "Json", "-o", "/out/%c.json", "--include-threads", "All"]);
    expect(exporterArgs("200", "/out", {}, "2026-01-01T00:00:00.000Z")).toContain("2026-01-01T00:00:00.000Z");
  });

  it("reports the exporter's reason rather than its stack trace", () => {
    // Captured from DiscordChatExporter 2.48 for a channel the account cannot read.
    const output = "Resolving channel(s)...\nERROR\nDiscordChatExporter.Core.Exceptions.DiscordChatExporterException: Request to 'channels/1423745568038977557' failed: forbidden.\n"
      + "   at DiscordChatExporter.Core.Discord.DiscordClient.GetJsonResponseAsync(String url, CancellationToken cancellationToken)\n".repeat(7);
    expect(summarizeOutput(output)).toBe("Request to 'channels/1423745568038977557' failed: forbidden.");
  });

  it("sweeps every server and DM the account can see, one channel at a time", async () => {
    const fake = join(directory, "fake-dce.ts");
    const log = join(directory, "calls.log");
    const fixtures = join(directory, "fixtures");
    mkdirSync(fixtures);
    for (const id of ["200", "500"]) writeFileSync(join(fixtures, `${id}.json`), JSON.stringify(dceExport(
      [dceMessage(`${id}1`, 0, "a"), dceMessage(`${id}2`, 1, "b"), dceMessage(`${id}3`, 2, "c")],
      { id, type: id === "500" ? "DirectTextChat" : "GuildTextChat", name: id === "500" ? "Bob" : "general", category: "Text" })));
    writeFileSync(fake, `
      import { appendFileSync } from "node:fs";
      const args = process.argv.slice(2);
      appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, token: process.env.DISCORD_TOKEN }) + "\\n");
      const listings = { guilds: "0 | Direct Messages\\n100 | Shale Dev", channels: "200 | Text / general\\n300 | Text / secret\\n400 | Text / broken", dm: "500 | Bob" };
      if (listings[args[0]]) { console.log(listings[args[0]]); process.exit(0); }
      const id = args[args.indexOf("-c") + 1];
      if (id === "300") { console.log("Resolving channel(s)..."); console.error("ERROR\\nDiscordChatExporter.Core.Exceptions.DiscordChatExporterException: Request to 'channels/300' failed: forbidden.\\n" + "   at DiscordChatExporter.Core.Discord.DiscordClient.GetJsonResponseAsync(String url)\\n".repeat(8)); process.exit(1); }
      if (id === "400") { console.error("ERROR: Something broke."); process.exit(1); }
      await Bun.write(args[args.indexOf("-o") + 1].replace("%c", id), Bun.file(${JSON.stringify(fixtures)} + "/" + id + ".json"));
    `);
    sdk.credentials.set({ token: "secret-token", kind: "user" });
    configure({ dceCommand: [process.execPath, fake] });
    const calls = async () => (await Bun.file(log).text()).trim().split("\n").map(line => JSON.parse(line));
    const indexedAfterExports: string[][] = [];
    sdk.messages.on("source:ingested", async () => {
      indexedAfterExports.push((await calls()).filter(call => call.args[0] === "export").map(call => call.args[2]));
    });

    const result = await sync(sdk);
    expect(result!.synced).toMatchObject({ channels: 2, skipped: 1, messages: 6 });
    expect(result!.synced.errors).toEqual([expect.stringContaining("Something broke")]);
    expect(result!.indexed.indexed).toBe(2);
    expect(indexedAfterExports).toEqual([["200"], ["200", "300", "400", "500"]]);
    const first = await calls();
    expect(first.map(c => c.args[0])).toEqual(["guilds", "channels", "dm", "export", "export", "export", "export"]);
    expect(first.every(c => c.token === "secret-token" && !c.args.includes("secret-token"))).toBe(true);
    expect(first.find(c => c.args.includes("200")).args).not.toContain("--after"); // full history on first sync
    expect(sdk.state.getWatermark("sync:channel:200")).toBe(new Date(T0 + 2 * 60_000 - 1000).toISOString());
    expect(sdk.state.getWatermark("sync:channel:500")).toBeTruthy();
    expect(sdk.state.getWatermark("sync:channel:400")).toBeNull();
    expect(auth.status(sdk)).toMatchObject({ connected: true, detail: expect.stringContaining("2 channel(s), 6 new message(s), 1 without access, 1 error(s)") });

    // Next run: resumes from watermarks, skips the forbidden channel, retries the failed one.
    rmSync(log);
    const again = await sync(sdk);
    expect(again!.synced).toMatchObject({ channels: 2, skipped: 1, messages: 0 });
    const second = (await calls()).filter(c => c.args[0] === "export");
    expect(second.map(c => c.args[2])).toEqual(["200", "400", "500"]);
    expect(second.find(c => c.args[2] === "200").args).toContain(new Date(T0 + 2 * 60_000 - 1000).toISOString());
    sdk.credentials.clear();
  });

  it("does nothing on the sync cron while sync is disabled", async () => {
    configure({ syncEnabled: false });
    expect(await sync(sdk)).toBeNull();
  });

  it("ingests successful partial exports without advancing past a failed thread", async () => {
    const fake = join(directory, "partial-dce.ts");
    const fixture = join(directory, "partial.json");
    const recovered = join(directory, "recovered");
    writeFileSync(fixture, JSON.stringify(dceExport([dceMessage("2001", 0, "a"), dceMessage("2002", 1, "b")])));
    writeFileSync(fake, `
      import { existsSync } from "node:fs";
      const args = process.argv.slice(2);
      await Bun.write(args[args.indexOf("-o") + 1].replace("%c", "200"), Bun.file(${JSON.stringify(fixture)}));
      console.log("Successfully exported 1 channel(s).");
      if (!existsSync(${JSON.stringify(recovered)}))
        console.error("Failed to export the following channel(s):\\nThread / hidden: Access forbidden. secret-token");
    `);
    sdk.credentials.set({ token: "secret-token", kind: "user" });
    configure({ syncScope: "selected", channels: ["200"], dceCommand: [process.execPath, fake] });
    const partial = await sync(sdk);
    expect(partial!.synced).toMatchObject({ channels: 1, messages: 2, skipped: 0 });
    expect(partial!.synced.errors).toEqual([expect.stringContaining("partially exported")]);
    expect(JSON.stringify(partial!.synced.errors)).not.toContain("secret-token");
    expect(partial!.indexed.indexed).toBe(1);
    expect(sdk.state.getWatermark("sync:channel:200")).toBeNull();
    expect(sdk.state.getWatermark("forbidden:200")).toBeNull();
    writeFileSync(recovered, "ready");
    const complete = await sync(sdk);
    expect(complete!.synced).toMatchObject({ channels: 1, messages: 0, errors: [] });
    expect(sdk.state.getWatermark("sync:channel:200")).toBe(new Date(T0 + 60_000 - 1000).toISOString());
  });

  it("explains a missing exporter instead of failing silently", async () => {
    sdk.credentials.set({ token: "t", kind: "user" });
    configure({ dceCommand: [join(directory, "does-not-exist")] });
    const result = await sync(sdk);
    expect(result!.synced.errors).toEqual([expect.stringContaining("bun run setup discord")]);
    sdk.credentials.clear();
  });

  it("connects a token through the auth provider and uses it for sync", async () => {
    const realFetch = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const header = new Headers(init?.headers).get("Authorization")!;
      seen.push(header);
      return header.endsWith("good-token")
        ? Response.json({ id: "1", username: "alice", global_name: "Alice", bot: header.startsWith("Bot ") })
        : new Response("{}", { status: 401 });
    }) as typeof fetch;
    try {
      await expect(auth.connect(sdk, "user", { token: "bad" })).rejects.toThrow("rejected");
      expect(auth.status(sdk)).toMatchObject({ connected: false });
      const status = await auth.connect(sdk, "user", { token: ' "good-token" ' });
      expect(status).toMatchObject({ connected: true, account: "Alice (@alice)" });
      expect(sdk.credentials.get("token")).toBe("good-token");
      await expect(auth.connect(sdk, "bot", { token: "Bot good-token" })).resolves.toMatchObject({ connected: true });
      expect(seen.at(-1)).toBe("Bot good-token");
      expect(await auth.verify!(sdk)).toMatchObject({ connected: true });
      await auth.disconnect(sdk);
      expect(sdk.credentials.all()).toEqual({});
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("syncs with a token connected in the web interface", async () => {
    const fake = join(directory, "fake-dce.ts");
    const log = join(directory, "calls.log");
    writeFileSync(fake, `await Bun.write(${JSON.stringify(log)}, process.env.DISCORD_TOKEN ?? "");`);
    sdk.credentials.set({ token: "stored-token", kind: "user" });
    configure({ syncEnabled: true, syncScope: "selected", dceCommand: [process.execPath, fake], tokenEnv: "TEST_DISCORD_UNSET", channels: ["200"] });
    const result = await sync(sdk);
    expect(result!.synced.errors).toEqual([]);
    expect(await Bun.file(log).text()).toBe("stored-token");
    sdk.credentials.clear();
  });
});
