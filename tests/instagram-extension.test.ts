import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionSDK, createMessageBus, type ShaleSDK } from "../sdk";
import { run } from "../extensions/instagram";
import { run as sync } from "../extensions/instagram/sync";
import { fixMojibake } from "../extensions/instagram/mojibake";
import { parseInstagramThread } from "../extensions/instagram/parse-export";
import { auth } from "../extensions/instagram/auth";
import { isTExtensionManifest } from "../lib/extension";
import manifest from "../extensions/instagram/manifest.json";
import { createTestDatabase } from "./fixtures/database";

const T0 = Date.UTC(2026, 0, 5, 10, 0);
const at = (minute: number) => T0 + minute * 60_000;
/** Encode text the way Instagram's export does: UTF-8 bytes written as Latin-1 code points. */
const garble = (text: string) => Buffer.from(text, "utf8").toString("latin1");

let directory: string;
let database: ReturnType<typeof createTestDatabase>;
let sdk: ShaleSDK;

function configure(settings: Record<string, unknown>) {
  writeFileSync(join(directory, "settings.json"), JSON.stringify({ importDir: join(directory, "import"), namespace: "instagram", ...settings }));
}

function writeThread(folder: string, file: string, messages: unknown[], participants = ["Zoë Example", "Sam Me"]) {
  const dir = join(directory, "import", "your_instagram_activity", "messages", "inbox", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), JSON.stringify({ participants: participants.map(name => ({ name: garble(name) })),
    messages, title: garble(participants[0]!), is_still_participant: true, thread_path: `inbox/${folder}` }));
}

const count = (sql: string) => database.query<{ n: number }, []>(`SELECT count(*) AS n FROM (${sql})`).get()!.n;
const allText = () => database.query<{ t: string }, []>("SELECT group_concat(text_content,'\n') AS t FROM chunks").get()!.t ?? "";

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "shale-instagram-"));
  database = createTestDatabase();
  sdk = createExtensionSDK("instagram", { database, messageBus: createMessageBus(), extensionDir: directory });
  sdk.logger.log = () => {};
  sdk.logger.warn = () => {};
  sdk.logger.error = () => {};
  sdk.queryLLM = (async () => JSON.stringify({ title: "Weekend plans", summary: "Zoë and Sam planned a hike.", topics: ["hiking"] })) as unknown as typeof sdk.queryLLM;
  configure({});
});

afterEach(() => {
  sdk.messages.clear();
  database.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("instagram extension", () => {
  it("has an auto-discoverable manifest", () => {
    expect(isTExtensionManifest(manifest)).toBe(true);
  });

  it("repairs export mojibake without touching correct text", () => {
    expect(fixMojibake(garble("café 😀 naïve"))).toBe("café 😀 naïve");
    expect(fixMojibake("café")).toBe("café");
    expect(fixMojibake("plain ascii")).toBe("plain ascii");
    expect(fixMojibake("😀 already fine")).toBe("😀 already fine");
  });

  it("parses newest-first exports, shares, reactions, and notices", () => {
    const parsed = parseInstagramThread({
      participants: [{ name: garble("Zoë Example") }, { name: "Sam Me" }],
      messages: [
        { sender_name: "Sam Me", timestamp_ms: at(2), content: "Sam Me sent an attachment.", share: { link: "https://www.instagram.com/p/abc/", share_text: "Trail map", original_content_owner: "parks" } },
        { sender_name: garble("Zoë Example"), timestamp_ms: at(1), content: "Liked a message" },
        { sender_name: garble("Zoë Example"), timestamp_ms: at(0), content: garble("Hike on Saturday? 🥾"), reactions: [{ reaction: garble("❤️"), actor: "Sam Me" }] },
      ],
    }, "/x/inbox/zoe_123/message_1.json");
    expect(parsed.conversation).toMatchObject({ conversationId: "export:zoe_123", title: "Zoë Example, Sam Me", kind: "dm" });
    expect(parsed.messages.map(m => m.sentAt)).toEqual([at(0), at(1), at(2)]);
    expect(parsed.messages[0]).toMatchObject({ authorName: "Zoë Example", text: "Hike on Saturday? 🥾", reactions: [{ emoji: "❤️", count: 1 }] });
    expect(parsed.messages[1]!.isSystem).toBe(true);
    expect(parsed.messages[2]).toMatchObject({ text: "", attachments: [{ kind: "link", name: "post by parks", text: "Trail map" }] });
    expect(parsed.messages[2]!.isSystem).toBeUndefined();
  });

  it("imports multi-file threads into one conversation with name-keyed people", async () => {
    writeThread("zoe_123", "message_1.json", [
      { sender_name: garble("Zoë Example"), timestamp_ms: at(3), content: "See you at 9" },
      { sender_name: "Sam Me", timestamp_ms: at(2), content: garble("Perfect, I’ll bring snacks") },
    ]);
    writeThread("zoe_123", "message_2.json", [
      { sender_name: "Sam Me", timestamp_ms: at(1), content: "Which trail?" },
      { sender_name: garble("Zoë Example"), timestamp_ms: at(0), content: "Hike on Saturday?" },
    ]);
    const result = await run(sdk);
    expect(result!.imported).toMatchObject({ files: 2, messages: 4 });
    expect(result!.indexed.indexed).toBe(1);
    expect(count("SELECT 1 FROM sources WHERE origin='instagram' AND type='chat_session'")).toBe(1);
    expect(allText()).toContain("Zoë Example: Hike on Saturday?");
    expect(allText()).toContain("Sam Me: Perfect, I’ll bring snacks");
    expect(count("SELECT 1 FROM entities WHERE type='Person'")).toBe(2);
    // Export authors have no platform ids, so no external-id aliases are claimed.
    expect(count("SELECT 1 FROM graph_aliases WHERE scope='external:instagram'")).toBe(0);
  });

  it("merges sidecar messages into the exported thread without duplicates", async () => {
    writeThread("zoe_123", "message_1.json", [
      { sender_name: "Sam Me", timestamp_ms: at(1), content: "Which trail?" },
      { sender_name: garble("Zoë Example"), timestamp_ms: at(0), content: "Hike on Saturday?" },
    ]);
    await run(sdk);
    const ndjson = join(directory, "sidecar.ndjson");
    const users = { viewer: { pk: "9", name: "Sam Me" }, users: [{ pk: "7", name: "Zoë Example", username: "zoe" }] };
    writeFileSync(ndjson, [
      JSON.stringify({ type: "thread", thread: { id: "340282366", title: "", is_group: false, ...users }, messages: [
        { id: "m1", user_id: "7", timestamp: at(0) + 450, text: "Hike on Saturday?", item_type: "text", attachments: [], reactions: [], is_system: false },
        { id: "m3", user_id: "7", timestamp: at(300), text: "Back home, great hike!", item_type: "text", attachments: [], reactions: [], is_system: false },
      ] }),
      JSON.stringify({ type: "done", threads: 1 }),
    ].join("\n") + "\n");
    const fakePython = join(directory, "fake-python");
    writeFileSync(fakePython, `#!/bin/sh\ncat > /dev/null\ncat ${JSON.stringify(ndjson)}\n`);
    chmodSync(fakePython, 0o755);
    process.env.TEST_IG_USER = "sam";
    process.env.TEST_IG_PASS = "pw";
    try {
      configure({ syncEnabled: true, pythonBin: fakePython, usernameEnv: "TEST_IG_USER", passwordEnv: "TEST_IG_PASS",
        sessionFile: join(directory, "session.json") });
      const result = await sync(sdk);
      expect(result!.synced).toMatchObject({ threads: 1, messages: 1, errors: [] });
      expect(count("SELECT 1 FROM instagram_conversations")).toBe(1);
      expect(count("SELECT 1 FROM instagram_messages")).toBe(3);
      expect(sdk.state.getJson<Record<string, number>>("sync:since")).toEqual({ "340282366": at(300) });
      expect(count("SELECT 1 FROM graph_aliases WHERE scope='external:instagram' AND alias='7'")).toBe(1);
      expect(allText()).toContain("Back home, great hike!");
    } finally {
      delete process.env.TEST_IG_USER;
      delete process.env.TEST_IG_PASS;
    }
  });

  it("reports sidecar verification errors and skips sync without credentials", async () => {
    configure({ syncEnabled: true, usernameEnv: "TEST_IG_MISSING", passwordEnv: "TEST_IG_MISSING" });
    expect((await sync(sdk))!.synced).toMatchObject({ threads: 0, errors: [] });
    const fakePython = join(directory, "fake-python");
    writeFileSync(fakePython, `#!/bin/sh\ncat > /dev/null\necho '{"type":"error","code":"challenge_required","message":"verify"}'\nexit 2\n`);
    chmodSync(fakePython, 0o755);
    process.env.TEST_IG_USER = "sam";
    process.env.TEST_IG_PASS = "pw";
    try {
      configure({ syncEnabled: true, pythonBin: fakePython, usernameEnv: "TEST_IG_USER", passwordEnv: "TEST_IG_PASS",
        sessionFile: join(directory, "session.json") });
      expect((await sync(sdk))!.synced.errors).toEqual(["challenge_required: verify"]);
    } finally {
      delete process.env.TEST_IG_USER;
      delete process.env.TEST_IG_PASS;
    }
  });

  it("signs in through the auth provider, asking for a two-factor code", async () => {
    const session = join(directory, "session.json");
    const fakePython = join(directory, "fake-python");
    // Stands in for `ig_sync.py --auth`: asks for a code, then saves a session.
    writeFileSync(fakePython, `#!/bin/sh
session=""; mode=""
while [ $# -gt 0 ]; do case "$1" in --session) session="$2"; shift;; --auth) mode=auth;; --check) mode=check;; esac; shift; done
if [ "$mode" = check ]; then echo '{"type":"ok","account":{"pk":"9","username":"sam","full_name":"Sam Me"}}'; exit 0; fi
read request
case "$request" in *wrongpw*) echo '{"type":"error","code":"login_required","message":"Bad password"}'; exit 2;; esac
echo '{"type":"need_code","kind":"two_factor","prompt":"Enter the two-factor code."}'
read code
case "$code" in *654321*) echo '{}' > "$session"; echo '{"type":"ok","account":{"pk":"9","username":"sam","full_name":"Sam Me"}}';;
  *) echo '{"type":"error","code":"two_factor_required","message":"Wrong code"}'; exit 2;; esac
`);
    chmodSync(fakePython, 0o755);
    configure({ pythonBin: fakePython, sessionFile: session });
    await expect(auth.connect(sdk, "password", { username: "sam", password: "wrongpw" })).rejects.toThrow("Bad password");
    const waiting = await auth.connect(sdk, "password", { username: "@sam", password: "pw" });
    expect(waiting).toMatchObject({ connected: false, pending: { prompt: "Enter the two-factor code.", field: { key: "code" } } });
    expect(auth.status(sdk)).toMatchObject({ pending: { prompt: "Enter the two-factor code." } });
    const done = await auth.submit!(sdk, { code: "654321" });
    expect(done).toMatchObject({ connected: true, account: "Sam Me (@sam)" });
    expect(sdk.credentials.all()).toMatchObject({ username: "sam", password: "pw", userId: "9" });
    expect(await auth.verify!(sdk)).toMatchObject({ connected: true });
    await auth.disconnect(sdk);
    expect(auth.status(sdk)).toMatchObject({ connected: false });
    expect(await Bun.file(session).exists()).toBe(false);
  });
});
