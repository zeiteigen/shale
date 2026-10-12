import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionSDK, createMessageBus, type ShaleSDK } from "../sdk";
import { createTestDatabase } from "./fixtures/database";
import { run } from "../extensions/email";
import { run as sync, mailboxCursorKey } from "../extensions/email/sync";
import { run as recover } from "../extensions/email/recover";
import { setup } from "../extensions/email/refresh";
import { emailConnector } from "../extensions/email/connector";
import { emailAccount, validateAccount } from "../extensions/email/account";
import { auth } from "../extensions/email/auth";
import { readerEvents, type EmailAccount, type EmailRecord, type MailboxCursor } from "../extensions/email/reader";
import { ingestEmail } from "../extensions/email/ingest";
import { classifySource } from "../lib/access/heuristics";
import { DEFAULT_POLICY } from "../lib/access/policy";
import { isTExtensionManifest } from "../lib/extension";
import manifest from "../extensions/email/manifest.json";

let directory: string;
let database: ReturnType<typeof createTestDatabase>;
let sdk: ShaleSDK;
let previousPassword: string | undefined;
const account: EmailAccount = { host: "imap.example.test", port: 993, username: "zeiteigen@example.test", password: "test-secret" };

function configure(settings: Record<string, unknown> = {}) {
  writeFileSync(join(directory, "settings.json"), JSON.stringify({ importDir: join(directory, "import"),
    namespace: "email", summarize: false, idleMinutes: 0, ...settings }));
}

function eml(id: string, text: string, extra = "") {
  return `From: Alice <alice@example.test>\nTo: Bob <bob@example.test>\nSubject: A project update\n`
    + `Date: Mon, 5 Jan 2026 10:00:00 +0000\nMessage-ID: <${id}@example.test>\n${extra}`
    + `Content-Type: text/plain; charset=utf-8\n\n${text}\n`;
}

function record(id: string, references: string[] = [], replyToId?: string): EmailRecord {
  return { subject: "A project update", references, message: { messageId: id, authorId: "alice@example.test",
    authorName: "Alice <alice@example.test>", sentAt: Date.UTC(2026, 0, 5, 10), text: `Project update ${id}`,
    replyToId, attachments: [] } };
}

/** A fake Python interpreter replays reader events and records requests without any real network/account. */
function fakeReader(events: Record<string, unknown[]>, exit = 0) {
  const fixture = readFileSync(join(import.meta.dir, "fixtures/email-reader.py"), "utf8");
  const fake = join(directory, "fake-python");
  writeFileSync(fake, `#!/usr/bin/env python3\n${fixture}`, { mode: 0o755 });
  writeFileSync(join(directory, "plan.json"), JSON.stringify({ ...events, exit }));
  configure({ pythonBin: fake, mailboxes: ["INBOX", "Sent"] });
  return fake;
}

const mailbox = (name = "INBOX", validity = "42") => ({ type: "mailbox", mailbox: name, uidValidity: validity });
const mailEvent = (uid: number, id: string, name = "INBOX", validity = "42") =>
  ({ type: "message", mailbox: name, uidValidity: validity, uid, record: record(id) });
const request = () => JSON.parse(readFileSync(join(directory, "request.json"), "utf8"));

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "shale-email-"));
  mkdirSync(join(directory, "import"));
  database = createTestDatabase();
  sdk = createExtensionSDK("email", { database, messageBus: createMessageBus(), extensionDir: directory });
  sdk.logger.log = () => {};
  sdk.logger.warn = () => {};
  sdk.logger.error = () => {};
  sdk.credentials.clear();
  previousPassword = process.env.EMAIL_PASSWORD;
  delete process.env.EMAIL_PASSWORD;
  configure();
});

afterEach(() => {
  sdk.credentials.clear();
  sdk.messages.clear();
  database.close();
  rmSync(directory, { recursive: true, force: true });
  if (previousPassword === undefined) delete process.env.EMAIL_PASSWORD;
  else process.env.EMAIL_PASSWORD = previousPassword;
});

describe("email extension", () => {
  it("is discoverable and defaults email to private even under an existing policy", () => {
    expect(isTExtensionManifest(manifest)).toBe(true);
    expect(DEFAULT_POLICY.originTiers.email).toBe("private");
    expect(classifySource({ title: "Hello", text: "A recipe", type: "chat_session", origin: "email", uri: "email://thread/1" }).tier).toBe(2);
  });

  it("runs the actual standard-library MIME and passive IMAP contract tests", async () => {
    const child = Bun.spawn(["python3", join(import.meta.dir, "fixtures/email-sidecar-tests.py")],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ code, output: stdout + stderr }).toMatchObject({ code: 0 });
    expect(stderr).toContain("OK");
  });

  it("imports nested exports into searchable sources and sender entities, without duplicate copies", async () => {
    mkdirSync(join(directory, "import", "nested"));
    const original = eml("root", "Please review the launch plan.");
    writeFileSync(join(directory, "import", "root.eml"), original);
    writeFileSync(join(directory, "import", "nested", "reply.EML"), eml("reply", "The launch plan looks good.",
      "References: <root@example.test>\nIn-Reply-To: <root@example.test>\n"));
    writeFileSync(join(directory, "import", "copy.mbox"), `From alice@example.test Mon Jan 5 10:00:00 2026\n${original}\n`);
    const result = (await run(sdk))!;
    expect(result.imported).toMatchObject({ files: 3, messages: 2, errors: [] });
    expect(result.indexed).toMatchObject({ indexed: 1, errors: [] });
    const sources = database.query<{ id: string; origin: string; uri: string }, []>("SELECT id,origin,uri FROM sources").all();
    expect(sources).toHaveLength(1);
    expect(sources[0]!.origin).toBe("email");
    expect(sources[0]!.uri).toStartWith("email://inbox/thread/");
    const transcript = database.query<{ text: string }, []>("SELECT group_concat(text_content) AS text FROM chunks").get()!.text;
    expect(transcript).toContain("Please review the launch plan.");
    expect(transcript).toContain("To: Bob <bob@example.test>");
    expect(database.query("SELECT 1 FROM graph_aliases WHERE scope='external:email' AND alias='alice@example.test'").get()).not.toBeNull();
    expect(emailConnector(sdk).store.stats()).toMatchObject({ conversations: 1, messages: 2, windows: 1 });
    expect((await run(sdk))!.imported).toMatchObject({ files: 0, skipped: 3, messages: 0 });
    expect((await run(sdk, true))!.indexed.indexed).toBe(0);
  });

  it("keeps unrelated equal subjects separate and merges partial reply chains when the parent arrives", async () => {
    const connector = emailConnector(sdk);
    ingestEmail(sdk, connector, record("<root>"));
    ingestEmail(sdk, connector, record("<child>", [], "<missing-parent>"));
    expect((await run(sdk))!.indexed.indexed).toBe(2);
    ingestEmail(sdk, connector, record("<missing-parent>", [], "<root>"));
    expect(connector.store.stats().conversations).toBe(1);
    await run(sdk);
    expect(database.query("SELECT id FROM sources").all()).toHaveLength(1);
    expect(connector.store.stats().messages).toBe(3);
    expect(ingestEmail(sdk, connector, record("<child>", [], "<missing-parent>"))).toBe(0);
    ingestEmail(sdk, connector, record("<unrelated>"));
    expect(connector.store.stats().conversations).toBe(2);
  });

  it("preserves partial file imports and retries invalid exports without marking them complete", async () => {
    const path = join(directory, "import", "partial.mbox");
    writeFileSync(path, `From alice Mon Jan 5 10:00:00 2026\n${eml("root", "Keep this mail")}\n`
      + "From broken Mon Jan 5 10:00:00 2026\nSubject: malformed\n\nNo sender\n");
    const failed = (await run(sdk))!;
    expect(failed.imported.errors).toHaveLength(1);
    expect(sdk.state.getWatermark(`import:${path}`)).toBeNull();
    expect(emailConnector(sdk).store.stats().messages).toBe(1);
    writeFileSync(path, `From alice Mon Jan 5 10:00:00 2026\n${eml("root", "Keep this mail")}\n`
      + `From alice Mon Jan 5 10:00:00 2026\n${eml("fixed", "Fixed mail")}\n`);
    expect((await run(sdk))!.imported).toMatchObject({ files: 1, messages: 1, errors: [] });
  });

  it("recovers committed-message checkpoints without another model call, and supports refresh", async () => {
    writeFileSync(join(directory, "import", "one.eml"), eml("root", "Project update"));
    const ingest = sdk.ingest.sourceAndChunks.bind(sdk.ingest);
    sdk.ingest.sourceAndChunks = () => { throw new Error("disk full"); };
    expect((await run(sdk))!.indexed.errors).toHaveLength(1);
    expect(database.query("SELECT id FROM checkpoints").all()).toHaveLength(1);
    sdk.ingest.sourceAndChunks = ingest;
    sdk.queryLLM = (async () => { throw new Error("Recovery must not call the model"); }) as typeof sdk.queryLLM;
    expect(await recover(sdk)).toEqual({ recoveredWindows: 1 });
    setup(sdk);
    const sourceId = database.query<{ id: string }, []>("SELECT id FROM sources").get()!.id;
    expect(await sdk.messages.request("source:refresh", { sourceId, actor: "test", reason: "Refresh email summary" }))
      .toMatchObject({ sourceId, status: "refreshed" });
  });

  it("skips live sync without credentials, honors disabled sync, and reads settings fresh", async () => {
    expect((await sync(sdk))!.synced).toMatchObject({ mailboxes: 0, messages: 0, errors: [] });
    configure({ syncEnabled: false });
    expect(await sync(sdk)).toBeNull();
    configure({ host: account.host, username: account.username });
    process.env.EMAIL_PASSWORD = account.password;
    expect(emailAccount(sdk)).toEqual(account);
  });

  it("commits per-message UID cursors through partial failures and deduplicates across folders", async () => {
    sdk.credentials.set({ ...account, port: "993" });
    fakeReader({ sync: [mailbox(), mailEvent(1, "<first>"), { type: "error", message: "INBOX fetch interrupted" },
      mailbox("Sent"), mailEvent(3, "<first>", "Sent"), { type: "done" }] });
    const partial = (await sync(sdk))!;
    expect(partial.synced).toMatchObject({ mailboxes: 2, messages: 1, errors: ["INBOX fetch interrupted"] });
    expect(sdk.state.getJson<MailboxCursor>(mailboxCursorKey(account, "INBOX"))).toEqual({ uidValidity: "42", uid: 1 });
    expect(sdk.state.getJson<MailboxCursor>(mailboxCursorKey(account, "Sent"))).toEqual({ uidValidity: "42", uid: 3 });
    fakeReader({ sync: [mailbox(), mailEvent(2, "<second>"), { type: "done" }] });
    expect((await sync(sdk))!.synced.messages).toBe(1);
    expect(request().cursors.INBOX).toEqual({ uidValidity: "42", uid: 1 });
    expect(request().account.password).toBeUndefined();
    // A server recreation can reuse smaller UIDs: validity, rather than UID alone, controls the reset.
    fakeReader({ sync: [mailbox("INBOX", "99"), mailEvent(1, "<first>", "INBOX", "99"), { type: "done" }] });
    expect((await sync(sdk))!.synced.messages).toBe(0);
    expect(sdk.state.getJson<MailboxCursor>(mailboxCursorKey(account, "INBOX"))).toEqual({ uidValidity: "99", uid: 1 });
    expect(emailConnector(sdk).store.stats().messages).toBe(2);
  });

  it("scopes cursors to account identity and refuses advancing beyond a failed database transaction", async () => {
    sdk.credentials.set({ ...account, port: "993" });
    fakeReader({ sync: [mailbox(), mailEvent(1, "<first>"), { type: "done" }] });
    const connector = emailConnector(sdk);
    database.run(`CREATE TRIGGER reject_email BEFORE INSERT ON ${connector.store.messages}
      BEGIN SELECT RAISE(ABORT,'disk full'); END`);
    expect((await sync(sdk))!.synced.errors.join(" ")).toContain("disk full");
    expect(sdk.state.getJson(mailboxCursorKey(account, "INBOX"))).toBeNull();
    expect(connector.store.stats().messages).toBe(0);
    database.run("DROP TRIGGER reject_email");
    expect((await sync(sdk))!.synced.messages).toBe(1);
    sdk.credentials.set({ username: "second@example.test" });
    fakeReader({ sync: [mailbox(), mailEvent(1, "<second-account>"), { type: "done" }] });
    expect((await sync(sdk))!.synced.messages).toBe(1);
    expect(request().cursors.INBOX).toBeNull();
    expect(sdk.state.getJson<MailboxCursor>(mailboxCursorKey({ ...account, username: "second@example.test" }, "INBOX")))
      .toEqual({ uidValidity: "42", uid: 1 });
  });

  it("rejects malformed UID sequences and incomplete reader processes without losing committed progress", async () => {
    sdk.credentials.set({ ...account, port: "993" });
    fakeReader({ sync: [mailbox(), mailEvent(1, "<first>"), mailEvent(1, "<invalid>"), { type: "done" }] });
    expect((await sync(sdk))!.synced.errors.join(" ")).toContain("invalid UID sequence");
    expect(emailConnector(sdk).store.stats().messages).toBe(1);
    fakeReader({ sync: [mailbox(), mailEvent(2, "<second>")] }, 1);
    expect((await sync(sdk))!.synced.errors.join(" ")).toContain("did not finish successfully");
    expect(sdk.state.getJson<MailboxCursor>(mailboxCursorKey(account, "INBOX"))).toEqual({ uidValidity: "42", uid: 2 });
  });

  it("connects and verifies through the generic account contract without returning passwords", async () => {
    fakeReader({ verify: [{ type: "verified" }, { type: "done" }] });
    const status = await auth.connect(sdk, "imap", { ...account, port: "993" });
    expect(status).toMatchObject({ connected: true, account: `${account.username} (${account.host}:993)` });
    expect(JSON.stringify(status)).not.toContain(account.password);
    expect(sdk.credentials.get("password")).toBe(account.password);
    expect((await auth.verify!(sdk)).connected).toBe(true);
    fakeReader({ verify: [{ type: "error", message: "Sign-in rejected" }] }, 1);
    await expect(auth.connect(sdk, "imap", { ...account, username: "other@example.test", port: "993" })).rejects.toThrow("Sign-in rejected");
    expect(emailAccount(sdk)).toEqual(account);
    await expect(auth.connect(sdk, "imap", { ...account, host: "bad\r\nhost", port: "993" })).rejects.toThrow("hostname");
    auth.disconnect(sdk);
    expect(await auth.status(sdk)).toMatchObject({ connected: false });
  });

  it("connects Gmail with a grouped app password and supplies the server without extra fields", async () => {
    fakeReader({ verify: [{ type: "verified" }, { type: "done" }] });
    const status = await auth.connect(sdk, "gmail", { username: "  zeiteigen@gmail.com  ", password: "abcd efgh ijkl mnop" });
    expect(status).toMatchObject({ connected: true, account: "zeiteigen@gmail.com (imap.gmail.com:993)" });
    expect(emailAccount(sdk)).toEqual({ host: "imap.gmail.com", port: 993,
      username: "zeiteigen@gmail.com", password: "abcdefghijklmnop" });
    expect(request().account).toEqual({ host: "imap.gmail.com", port: 993, username: "zeiteigen@gmail.com" });
    expect(JSON.stringify(status)).not.toContain("abcdefghijklmnop");
  });

  it("explains Gmail's app-password requirement before checking a normal password or 2FA code", async () => {
    for (const password of ["my-normal-google-password", "123456"]) {
      await expect(auth.connect(sdk, "gmail", { username: "zeiteigen@gmail.com", password }))
        .rejects.toThrow("https://myaccount.google.com/apppasswords");
    }
    expect(sdk.credentials.get("password")).toBeUndefined();
    await expect(auth.connect(sdk, "gmail", { username: "zeiteigen", password: "abcdefghijklmnop" }))
      .rejects.toThrow("full Gmail");
  });

  it("accepts grouped Gmail app passwords through generic IMAP and environment configuration without changing other providers", () => {
    expect(validateAccount({ ...account, host: "IMAP.GMAIL.COM", password: " abcd efgh ijkl mnop " }).password)
      .toBe("abcdefghijklmnop");
    expect(validateAccount({ ...account, password: " abcd efgh ijkl mnop " }).password).toBe(" abcd efgh ijkl mnop ");
    configure({ host: "imap.gmail.com", username: "zeiteigen@gmail.com" });
    process.env.EMAIL_PASSWORD = "abcd efgh ijkl mnop";
    expect(emailAccount(sdk)!.password).toBe("abcdefghijklmnop");
  });

  it("kills a stalled reader on timeout so the connector can retry", async () => {
    const fake = join(directory, "stalled-python");
    writeFileSync(fake, "#!/usr/bin/env python3\nimport time\ntime.sleep(60)\n", { mode: 0o755 });
    const read = async () => { for await (const _event of readerEvents({ pythonBin: fake, syncTimeoutMinutes: 0.001 },
      { action: "import", path: "unused" })) { /* no events */ } };
    await expect(read()).rejects.toThrow("timed out");
  });
});
