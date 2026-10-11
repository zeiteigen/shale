import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { statSync } from "node:fs";
import { createExtensionSDK, createMessageBus, type AuthProvider } from "../sdk";
import { credentialStore, credentialsPath } from "../lib/credentials";
import { createTestDatabase } from "./fixtures/database";
import { createWebHost } from "./fixtures/web-host";

/** A generic two-step provider: the host and UI must not know anything about it beyond this contract. */
const provider: AuthProvider = {
  title: "Demo service",
  description: "Demo account",
  warning: "Demo warning",
  methods: [{ id: "password", label: "Password", fields: [
    { key: "user", label: "User", type: "text", required: true },
    { key: "secret", label: "Secret", type: "password", required: true },
  ] }],
  status(sdk) {
    const stored = sdk.credentials.all();
    if (stored.pending) return { connected: false, pending: { prompt: "Enter the code", field: { key: "code", label: "Code", type: "text", required: true } } };
    return stored.secret ? { connected: true, account: stored.user } : { connected: false };
  },
  async connect(sdk, _method, values) {
    if (values.secret === "wrong") throw new Error("Rejected by service");
    sdk.credentials.set({ user: values.user!, pendingSecret: values.secret!, pending: "1" });
    return this.status(sdk);
  },
  async submit(sdk, values) {
    if (values.code !== "123") throw new Error("Wrong code");
    const stored = sdk.credentials.all();
    sdk.credentials.set({ secret: stored.pendingSecret!, pendingSecret: null, pending: null });
    return this.status(sdk);
  },
  disconnect: sdk => sdk.credentials.clear(),
};

let host: ReturnType<typeof createWebHost>;
let database: ReturnType<typeof createTestDatabase>;

beforeEach(() => {
  database = createTestDatabase();
  const sdk = createExtensionSDK("demo-auth", { database, messageBus: createMessageBus() });
  credentialStore.clear("demo-auth");
  host = createWebHost({ auth: new Map([["demo-auth", { provider, sdk }]]) });
});
afterEach(() => { host.close(); database.close(); credentialStore.clear("demo-auth"); });

const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${host.base}${path}`, {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("account auth API", () => {
  it("lists providers with their declared methods and no secrets", async () => {
    const { accounts } = await (await fetch(`${host.base}/api/auth`)).json();
    expect(accounts).toEqual([expect.objectContaining({ extension: "demo-auth", title: "Demo service", warning: "Demo warning",
      canVerify: false, status: { connected: false } })]);
    expect(accounts[0].methods[0].fields.map((f: { key: string }) => f.key)).toEqual(["user", "secret"]);
  });

  it("runs a multi-step sign-in and never echoes the secret", async () => {
    const missing = await post("/api/auth/demo-auth/connect", { method: "password", values: { user: "sam" } });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toContain("Secret");
    const rejected = await post("/api/auth/demo-auth/connect", { method: "password", values: { user: "sam", secret: "wrong" } });
    expect((await rejected.json()).error).toBe("Rejected by service");
    const started = await (await post("/api/auth/demo-auth/connect", { method: "password", values: { user: "sam", secret: "s3cret" } })).json();
    expect(started.status.pending.prompt).toBe("Enter the code");
    expect((await post("/api/auth/demo-auth/submit", { values: { code: "000" } })).status).toBe(400);
    const done = await (await post("/api/auth/demo-auth/submit", { values: { code: "123" } })).json();
    expect(done.status).toEqual({ connected: true, account: "sam" });
    const listing = await (await fetch(`${host.base}/api/auth`)).text();
    expect(listing).not.toContain("s3cret");
    expect(credentialStore.get("demo-auth", "secret")).toBe("s3cret");
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
  });

  it("requires confirmation to disconnect and clears stored credentials", async () => {
    credentialStore.set("demo-auth", { user: "sam", secret: "x" });
    expect((await post("/api/auth/demo-auth/disconnect", {})).status).toBe(400);
    const result = await (await post("/api/auth/demo-auth/disconnect", { confirm: true })).json();
    expect(result.status).toEqual({ connected: false });
    expect(credentialStore.all("demo-auth")).toEqual({});
  });

  it("rejects unknown extensions, unsupported actions, and cross-origin requests", async () => {
    expect((await post("/api/auth/nope/connect", { method: "password" })).status).toBe(404);
    expect((await post("/api/auth/demo-auth/verify", {})).status).toBe(400);
    expect((await post("/api/auth/demo-auth/connect", { method: "password", values: { user: "a", secret: "b" } },
      { Origin: "https://evil.example" })).status).toBe(403);
  });
});
