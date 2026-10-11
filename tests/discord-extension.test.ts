import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionSDK, createMessageBus, type ShaleSDK } from "../sdk";
import { run } from "../extensions/discord";
import { run as sync } from "../extensions/discord/sync";
import { run as recover } from "../extensions/discord/recover";
import { exporterArgs, syncTargets } from "../extensions/discord/dce";
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

  it("builds exporter arguments from targets and watermarks", () => {
    const settings = { channels: ["200"], guilds: ["100"], includeDMs: true, includeThreads: "active" as const, initialSyncDays: 1 };
    const targets = syncTargets(settings);
    expect(targets.map(t => t.key)).toEqual(["channel:200", "guild:100", "dm"]);
    expect(exporterArgs(targets[0]!, "/out", settings, null, T0)).toEqual(
      ["export", "-c", "200", "--include-threads", "Active", "-f", "Json", "-o", "/out/%c.json", "--after", new Date(T0 - 86_400_000).toISOString()]);
    expect(exporterArgs(targets[2]!, "/out", { initialSyncDays: 0 }, null)).toEqual(["exportdm", "-f", "Json", "-o", "/out/%c.json"]);
    expect(exporterArgs(targets[1]!, "/out", settings, "2026-01-01T00:00:00.000Z")).toContain("2026-01-01T00:00:00.000Z");
  });

  it("syncs with the exporter, passing the token by environment and advancing the watermark", async () => {
    const fake = join(directory, "fake-dce.ts");
    const fixture = join(directory, "fixture.json");
    const log = join(directory, "calls.log");
    writeFileSync(fixture, JSON.stringify(dceExport([dceMessage("10", 0, "a"), dceMessage("11", 1, "b"), dceMessage("12", 2, "c")])));
    writeFileSync(fake, `
      const args = process.argv.slice(2);
      const out = args[args.indexOf("-o") + 1].replace("%c", "200");
      await Bun.write(${JSON.stringify(log)}, JSON.stringify({ args, token: process.env.DISCORD_TOKEN }) + "\\n");
      await Bun.write(out, Bun.file(${JSON.stringify(fixture)}));
    `);
    process.env.TEST_DISCORD_TOKEN = "secret-token";
    try {
      configure({ syncEnabled: true, dceCommand: [process.execPath, fake], tokenEnv: "TEST_DISCORD_TOKEN", channels: ["200"], initialSyncDays: 0 });
      const result = await sync(sdk);
      expect(result!.synced).toMatchObject({ targets: 1, messages: 3, errors: [] });
      expect(result!.indexed.indexed).toBe(1);
      const call = JSON.parse(await Bun.file(log).text());
      expect(call.token).toBe("secret-token");
      expect(call.args).not.toContain("secret-token");
      expect(sdk.state.getWatermark("sync:channel:200")).toBe(new Date(T0 + 2 * 60_000 - 1000).toISOString());
    } finally {
      delete process.env.TEST_DISCORD_TOKEN;
    }
  });

  it("does nothing on the sync cron while sync is disabled", async () => {
    expect(await sync(sdk)).toBeNull();
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
    configure({ syncEnabled: true, dceCommand: [process.execPath, fake], tokenEnv: "TEST_DISCORD_UNSET", channels: ["200"] });
    const result = await sync(sdk);
    expect(result!.synced.errors).toEqual([]);
    expect(await Bun.file(log).text()).toBe("stored-token");
    sdk.credentials.clear();
  });
});
