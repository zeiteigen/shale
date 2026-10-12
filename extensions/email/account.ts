import type { ShaleSDK } from "@shale/sdk";
import { chatHash } from "@shale/sdk/chat/hash";
import { emailSettings } from "./connector";
import type { EmailAccount } from "./reader";
import { isGmailHost, normalizeGmailPassword } from "./gmail";

export const accountId = (account: EmailAccount) => chatHash([account.host.toLowerCase(), account.port, account.username]);

export function validateAccount(account: EmailAccount): EmailAccount {
  const host = account.host.trim();
  const username = account.username.trim();
  if (!host || /[\s/:\x00-\x1f]/.test(host)) throw new Error("Enter an IMAP hostname without a URL or port.");
  if (!Number.isInteger(account.port) || account.port < 1 || account.port > 65535) throw new Error("IMAP port must be between 1 and 65535.");
  if (!username || /[\r\n\x00]/.test(username)) throw new Error("Enter a valid IMAP username.");
  if (!account.password || /[\r\n\x00]/.test(account.password)) throw new Error("Enter a password or app password.");
  return { ...account, host, username,
    password: isGmailHost(host) ? normalizeGmailPassword(account.password) : account.password };
}

/** A browser-connected account is complete on its own; otherwise use settings and an environment password. */
export function emailAccount(sdk: ShaleSDK): EmailAccount | undefined {
  const settings = emailSettings(sdk);
  const stored = sdk.credentials.all();
  if (stored.password) return validateAccount({ host: stored.host ?? "", port: Number(stored.port),
    username: stored.username ?? "", password: stored.password });
  const password = sdk.credentials.resolve("password", settings.passwordEnv);
  if (!settings.host || !settings.username || !password) return undefined;
  return validateAccount({ host: settings.host, port: settings.port!, username: settings.username, password });
}

export function emailMailboxes(sdk: ShaleSDK): string[] {
  const names = emailSettings(sdk).mailboxes!;
  if (!Array.isArray(names) || !names.length || names.some(name => typeof name !== "string" || !name.trim() || /[\r\n\x00]/.test(name)))
    throw new Error("Configure at least one valid mailbox name (for example INBOX).");
  return [...new Set(names)];
}
