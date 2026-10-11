import { existsSync, rmSync } from "node:fs";
import type { AuthField, AuthProvider, AuthStatus, ShaleSDK } from "@shale/sdk";
import { instagramSettings } from "./connector";
import { SidecarProcess, sessionPath } from "./sidecar-process";
import { INSTAGRAM_DEFAULTS } from "./settings.types";

const RESPONSE_TIMEOUT_MS = 120_000;
const PENDING_TTL_MS = 5 * 60_000;
const CODE_FIELD: AuthField = { key: "code", label: "Security code", type: "text", required: true, placeholder: "123456" };

interface Pending { process: SidecarProcess; prompt: string; method: string; username?: string; password?: string; timer: Timer }
/** Sign-ins waiting for a code, per extension instance. The sidecar keeps Instagram's challenge state in memory. */
const pending = new Map<string, Pending>();

function cancel(extensionId: string) {
  const entry = pending.get(extensionId);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.process.kill();
  pending.delete(extensionId);
}

/** Stored credentials win; environment variables remain a headless fallback. */
export function instagramCredentials(sdk: ShaleSDK) {
  const settings = instagramSettings(sdk);
  return {
    username: sdk.credentials.resolve("username", settings.usernameEnv || INSTAGRAM_DEFAULTS.usernameEnv),
    password: sdk.credentials.resolve("password", settings.passwordEnv || INSTAGRAM_DEFAULTS.passwordEnv),
  };
}

function status(sdk: ShaleSDK, error?: string): AuthStatus {
  const waiting = pending.get(sdk.extensionId);
  if (waiting) return { connected: false, pending: { prompt: waiting.prompt, field: CODE_FIELD }, error };
  const stored = sdk.credentials.all();
  const hasSession = existsSync(sessionPath(instagramSettings(sdk)));
  if (hasSession) return {
    connected: true, account: stored.account ?? "Saved session", error,
    checkedAt: stored.checkedAt ? Number(stored.checkedAt) : undefined,
    detail: stored.password ? "Signed in. The saved password lets the sync sign in again if the session expires."
      : "Signed in. If the session expires, reconnect here.",
  };
  return { connected: false, error, detail: instagramCredentials(sdk).username
    ? "Credentials from data/.env were found; the first sync will try to sign in with them. Connecting here handles 2FA."
    : undefined };
}

function accountLabel(account: { username?: string; full_name?: string }) {
  return account.full_name ? `${account.full_name} (@${account.username})` : `@${account.username}`;
}

/** Drive the sign-in until it succeeds, fails, or asks the user for a code. */
async function advance(sdk: ShaleSDK, entry: Omit<Pending, "prompt" | "timer">): Promise<AuthStatus> {
  let event;
  try {
    event = await entry.process.next(RESPONSE_TIMEOUT_MS);
  } catch (error) {
    entry.process.kill();
    pending.delete(sdk.extensionId);
    throw error;
  }
  if (event?.type === "need_code") {
    const existing = pending.get(sdk.extensionId);
    if (existing) clearTimeout(existing.timer);
    pending.set(sdk.extensionId, { ...entry, prompt: String(event.prompt ?? "Enter the code Instagram sent you."),
      timer: setTimeout(() => cancel(sdk.extensionId), PENDING_TTL_MS) });
    return status(sdk);
  }
  const existing = pending.get(sdk.extensionId);
  if (existing) clearTimeout(existing.timer);
  pending.delete(sdk.extensionId);
  entry.process.close();
  if (event?.type === "ok") {
    sdk.credentials.set({
      account: accountLabel(event.account ?? {}), userId: event.account?.pk ?? null, checkedAt: String(Date.now()),
      username: event.account?.username ?? entry.username ?? null, password: entry.method === "password" ? entry.password ?? null : null,
    });
    return status(sdk);
  }
  entry.process.kill();
  const message = event?.type === "error" ? `${event.message}` : `The sign-in helper stopped unexpectedly${event?.detail ? `: ${event.detail}` : "."}`;
  throw new Error(event?.code === "missing_dependency" ? "The Instagram sidecar isn't installed. Run `bun run setup instagram` in the Shale folder, then try again." : message);
}

export const auth: AuthProvider = {
  title: "Instagram",
  description: "Used by the instagram-sync cron to fetch recent DMs through the instagrapi sidecar. The official data export in the import folder needs no account.",
  warning: "instagrapi uses Instagram's private API. Instagram can challenge, rate-limit, or restrict accounts that use it.",
  methods: [
    { id: "password", label: "Username & password", description: "Signs in like the Instagram app. If Instagram asks for a two-factor or security code, you'll be prompted for it here. The password is kept in data/credentials.json so the sync can sign in again when the session expires.",
      fields: [
        { key: "username", label: "Username", type: "text", required: true },
        { key: "password", label: "Password", type: "password", required: true },
      ] },
    { id: "session", label: "Session cookie", description: "Reuse a browser session instead of your password: copy the sessionid cookie for instagram.com from your browser's developer tools (Application → Cookies). The session ends if you log out in that browser.",
      fields: [{ key: "sessionid", label: "sessionid cookie", type: "password", required: true }] },
  ],
  status: sdk => status(sdk),
  async connect(sdk, method, values) {
    cancel(sdk.extensionId);
    const process = new SidecarProcess(instagramSettings(sdk), ["--auth"]);
    const request = method === "session"
      ? { method: "session", sessionid: values.sessionid!.trim() }
      : { method: "password", username: values.username!.trim().replace(/^@/, ""), password: values.password! };
    process.send(request);
    return advance(sdk, { process, method, username: "username" in request ? request.username : undefined,
      password: "password" in request ? request.password : undefined });
  },
  async submit(sdk, values) {
    const entry = pending.get(sdk.extensionId);
    if (!entry) throw new Error("The sign-in expired. Start again.");
    if (!values.code?.trim()) throw new Error("Enter the code.");
    entry.process.send({ code: values.code.trim() });
    return advance(sdk, entry);
  },
  async verify(sdk) {
    const settings = instagramSettings(sdk);
    if (!existsSync(sessionPath(settings))) return status(sdk, "No saved session. Connect first.");
    const { username, password } = instagramCredentials(sdk);
    const process = new SidecarProcess(settings, ["--check"], { IG_USERNAME: username, IG_PASSWORD: password });
    process.close();
    try {
      const event = await process.next(RESPONSE_TIMEOUT_MS);
      if (event?.type !== "ok") return status(sdk, event?.message ?? "The session could not be verified.");
      sdk.credentials.set({ account: accountLabel(event.account ?? {}), userId: event.account?.pk ?? null, checkedAt: String(Date.now()) });
      return status(sdk);
    } finally {
      process.kill();
    }
  },
  disconnect(sdk) {
    cancel(sdk.extensionId);
    rmSync(sessionPath(instagramSettings(sdk)), { force: true });
    sdk.credentials.clear();
  },
};

export default auth;
