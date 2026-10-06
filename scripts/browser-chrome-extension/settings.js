export const DEFAULTS = {
  serverUrl: "http://127.0.0.1:7425/ingest",
  autoSyncActive: true,
  excludeSocialMedia: true,
  excludeDomains: [
    "x.com",
    "twitter.com",
    "reddit.com",
    "facebook.com",
    "instagram.com",
    "tiktok.com",
    "linkedin.com",
    "youtube.com",
    "mail.google.com",
    "accounts.google.com",
  ],
  sessionIdleMinutes: 30,
  totalIngestedCount: 0,
  initialSyncCompleted: false,
  requestTimeoutMs: 10000,
  currentGoal: "",
};
export async function initializeSettings() {
  const saved = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const missing = Object.fromEntries(
    Object.entries(DEFAULTS).filter(([key]) => saved[key] === undefined),
  );
  if (Object.keys(missing).length) await chrome.storage.local.set(missing);
  const identity = await chrome.storage.local.get(["collectorId"]);
  if (!identity.collectorId)
    await chrome.storage.local.set({ collectorId: crypto.randomUUID() });
  const session = await chrome.storage.session.get(["browserInstanceId"]);
  if (!session.browserInstanceId)
    await chrome.storage.session.set({
      browserInstanceId: crypto.randomUUID(),
    });
}
let initialization;
export function readySettings() {
  return (initialization ??= initializeSettings());
}
export async function settings() {
  await readySettings();
  return {
    ...DEFAULTS,
    ...(await chrome.storage.local.get(null)),
    ...(await chrome.storage.session.get(["browserInstanceId"])),
  };
}
export function connectorUrl(endpoint, path) {
  return new URL(`/connectors/browser/${path}`, endpoint).href;
}
export function validatedEndpoint(value) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Use an HTTP(S) server URL without credentials");
  return url.href;
}
