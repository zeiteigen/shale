import type { AuthProvider, AuthStatus, ShaleSDK } from "@shale/sdk";
import { accountId, emailAccount, emailMailboxes, validateAccount } from "./account";
import { emailSettings, LAST_SYNC_KEY } from "./connector";
import { readerEvents, type EmailAccount } from "./reader";
import { GMAIL_APP_PASSWORD_URL, GMAIL_HOST, gmailAppPassword } from "./gmail";

async function verifyAccount(sdk: ShaleSDK, account: EmailAccount) {
  let verified = false;
  for await (const event of readerEvents({ ...emailSettings(sdk), syncTimeoutMinutes: 0.5 },
    { action: "verify", account, mailboxes: emailMailboxes(sdk) })) {
    if (event.type === "error") throw new Error(event.message);
    if (event.type === "verified") verified = true;
  }
  if (!verified) throw new Error("The email reader did not verify the account.");
}

function status(sdk: ShaleSDK, error?: string): AuthStatus {
  let account: EmailAccount | undefined;
  try { account = emailAccount(sdk); } catch (cause) {
    return { connected: false, error: error ?? (cause instanceof Error ? cause.message : String(cause)) };
  }
  if (!account) return { connected: false, error };
  const stored = sdk.credentials.all();
  const last = sdk.state.getJson<{ accountId: string; messages: number; errors: number; finishedAt: number }>(LAST_SYNC_KEY);
  let detail = "Read-only IMAP over TLS. ";
  if (emailSettings(sdk).syncEnabled === false) detail += "Sync is disabled.";
  else if (last && last.accountId === accountId(account)) detail += `Last sync ${new Date(last.finishedAt).toLocaleString()}: `
    + `${last.messages} new/edited message(s), ${last.errors} error(s).`;
  else detail += "Run email-sync from Overview or wait for the hourly cron.";
  return { connected: true, account: `${account.username} (${account.host}:${account.port})`,
    checkedAt: stored.checkedAt ? Number(stored.checkedAt) : undefined, detail, error };
}

export const auth: AuthProvider = {
  title: "Email",
  description: "Read mail using IMAP over TLS. Local .eml and .mbox imports need no account. Use an app password if your provider requires one.",
  methods: [{ id: "imap", label: "IMAP account", fields: [
    { key: "host", label: "IMAP server", type: "text", required: true, placeholder: "imap.example.com" },
    { key: "port", label: "TLS port", type: "text", placeholder: "993", help: "Implicit TLS only; usually 993." },
    { key: "username", label: "Username / email address", type: "text", required: true },
    { key: "password", label: "Password / app password", type: "password", required: true,
      help: "For Gmail with 2FA, choose Gmail (app password) for setup instructions." },
  ] }, { id: "gmail", label: "Gmail (app password)",
    description: `Keep Google 2-Step Verification enabled and create an app password for Shale at ${GMAIL_APP_PASSWORD_URL}. This connects over read-only IMAP; Google browser sign-in (OAuth) is not implemented.`,
    fields: [
      { key: "username", label: "Gmail address", type: "text", required: true, placeholder: "you@gmail.com",
        help: "Your full email address, including @gmail.com or your Google Workspace domain." },
      { key: "password", label: "Google app password", type: "password", required: true,
        help: "Paste the 16-character app password. Spaces between groups are accepted. Your Google password and 2FA code won't work here." },
    ] }],
  status: sdk => status(sdk),
  async connect(sdk, method, values) {
    if (method !== "imap" && method !== "gmail") throw new Error("Unknown email sign-in method.");
    if (method === "gmail" && !/^[^\s@]+@[^\s@]+$/.test(values.username?.trim() ?? ""))
      throw new Error("Enter your full Gmail or Google Workspace email address.");
    const account = validateAccount({ host: method === "gmail" ? GMAIL_HOST : values.host ?? "",
      port: method === "gmail" ? 993 : Number(values.port?.trim() || 993), username: values.username ?? "",
      password: method === "gmail" ? gmailAppPassword(values.password ?? "") : values.password ?? "" });
    await verifyAccount(sdk, account);
    sdk.credentials.set({ ...account, port: String(account.port), checkedAt: String(Date.now()) });
    return status(sdk);
  },
  async verify(sdk) {
    try {
      const account = emailAccount(sdk);
      if (!account) return status(sdk, "No IMAP account is connected.");
      await verifyAccount(sdk, account);
      if (sdk.credentials.get("password")) sdk.credentials.set({ checkedAt: String(Date.now()) });
      return status(sdk);
    } catch (error) { return status(sdk, error instanceof Error ? error.message : String(error)); }
  },
  disconnect: sdk => sdk.credentials.clear(),
};

export default auth;
