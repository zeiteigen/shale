/** Core settings; modules contribute their own defaults through `registerDefaults`. */
export const DEFAULTS = {
  serverUrl: "http://127.0.0.1:7425/ingest",
  totalIngestedCount: 0,
  requestTimeoutMs: 10000,
  /** Per-module enable flags; a module is enabled unless set to false. */
  modules: {},
};
const moduleDefaults = {};
export function registerDefaults(defaults) {
  Object.assign(moduleDefaults, defaults);
}
export async function initializeSettings() {
  const defaults = { ...DEFAULTS, ...moduleDefaults };
  const saved = await chrome.storage.local.get(Object.keys(defaults));
  const missing = Object.fromEntries(
    Object.entries(defaults).filter(([key]) => saved[key] === undefined),
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
    ...moduleDefaults,
    ...(await chrome.storage.local.get(null)),
    ...(await chrome.storage.session.get(["browserInstanceId"])),
  };
}
export function connectorUrl(endpoint, processor, path) {
  return new URL(
    `/connectors/${encodeURIComponent(processor)}/${path}`,
    endpoint,
  ).href;
}
/** Cached `/connectors/<processor>/policy`; the pre-module cache held only the browser policy. */
export function policyFor(config, processor) {
  const entry = config.capturePolicies?.[config.serverUrl];
  if (!entry) return undefined;
  if (entry.modules) return entry.modules[processor];
  return processor === "browser" ? entry : undefined;
}
export function moduleEnabled(config, id) {
  return config.modules?.[id] !== false;
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
