/** Removed aliases must not reappear as custom fields from older settings files. */
const removedRootSettings = new Set([
  "OPENAI_ENDPOINT", "OPENAI_MODEL",
  "OPENAI_CHAT_TIMEOUT_MS", "OPENAI_TIMEOUT_MS",
  "MAX_THINKING_TOKENS", "OPENAI_THINKING_BUDGET", "VISUALIZER_PORT",
]);
export function omitRemovedRootSettings<T>(values: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(values).filter(([key]) => !removedRootSettings.has(key)));
}
