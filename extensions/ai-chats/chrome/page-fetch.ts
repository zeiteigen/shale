/**
 * Runs inside a ChatGPT or Claude tab (via `chrome.scripting.executeScript({ func })`), so
 * requests are same-origin and carry the user's own session, exactly like the site's own UI.
 * Chrome serializes this function: it must not reference anything outside its body.
 *
 * `path` may contain `{org}`, replaced with the user's Claude organization id.
 */
export async function pageFetch(provider: "chatgpt" | "claude", path: string):
  Promise<{ ok: true; data: unknown } | { ok: false; status: number; error: string }> {
  const cache = ((globalThis as any).__shaleAiChats ??= {}) as { token?: string; tokenAt?: number; org?: string };
  const failure = (status: number, error: string) => ({ ok: false as const, status, error });
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (provider === "chatgpt") {
      if (!cache.token || Date.now() - (cache.tokenAt ?? 0) > 5 * 60_000) {
        const session = await fetch("/api/auth/session", { credentials: "include" });
        const body = session.ok ? await session.json() : null;
        if (!body?.accessToken) return failure(401, "Not signed in to ChatGPT in this browser");
        cache.token = body.accessToken;
        cache.tokenAt = Date.now();
      }
      headers.Authorization = `Bearer ${cache.token}`;
    }
    if (provider === "claude" && path.includes("{org}")) {
      if (!cache.org) {
        const response = await fetch("/api/organizations", { credentials: "include", headers });
        if (!response.ok) return failure(response.status, "Not signed in to Claude in this browser");
        const orgs = (await response.json()) as Array<{ uuid: string; capabilities?: string[] }>;
        cache.org = (orgs.find(org => org.capabilities?.includes("chat")) ?? orgs[0])?.uuid;
        if (!cache.org) return failure(403, "No Claude organization found for this account");
      }
      path = path.replace("{org}", encodeURIComponent(cache.org));
    }
    const response = await fetch(path, { credentials: "include", headers });
    if (response.status === 401 && provider === "chatgpt") cache.token = undefined;
    if (!response.ok) return failure(response.status, `${provider} returned HTTP ${response.status}`);
    return { ok: true, data: await response.json() };
  } catch (error) {
    return failure(0, error instanceof Error ? error.message : String(error));
  }
}
