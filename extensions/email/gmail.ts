export const GMAIL_HOST = "imap.gmail.com";
export const GMAIL_APP_PASSWORD_URL = "https://myaccount.google.com/apppasswords";

export function isGmailHost(host: string): boolean {
  return [GMAIL_HOST, "imap.googlemail.com"].includes(host.toLowerCase());
}

/** Google's app-password display groups characters with spaces. Preserve other IMAP passwords exactly. */
export function normalizeGmailPassword(password: string): string {
  const compact = password.trim().replace(/[ \u00a0]/g, "");
  return /^[a-z0-9]{16}$/i.test(compact) ? compact : password;
}

export function gmailAppPassword(password: string): string {
  const normalized = normalizeGmailPassword(password);
  if (!/^[a-z0-9]{16}$/i.test(normalized))
    throw new Error(`Gmail needs a 16-character Google app password. Create one for Shale at ${GMAIL_APP_PASSWORD_URL} with 2-Step Verification enabled. Enter that app password here; your Google password and 2FA code cannot sign in to this connector.`);
  return normalized;
}
