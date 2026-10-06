/** Explicit, bounded public-page fallback. Does not carry browser cookies. */
export async function fetchPublicPage(
  url: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const combined = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
    : AbortSignal.timeout(15000);
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const parsed = new URL(url);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password
    )
      throw new Error("Invalid public-page URL");
    response = await fetch(parsed, {
      signal: combined,
      redirect: "manual",
      headers: { Accept: "text/html" },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (!location || redirects === 5)
      throw new Error("Public-page redirect limit exceeded");
    url = new URL(location, url).href;
  }
  if (!response?.ok)
    throw new Error(`Could not fetch page (${response?.status})`);
  if (!response.headers.get("content-type")?.includes("text/html")) {
    await response.body?.cancel();
    throw new Error("Page is not HTML");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    length += item.value.length;
    if (length > maxBytes) {
      await reader.cancel();
      throw new Error("Fetched page exceeds byte limit");
    }
    parts.push(item.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return new TextDecoder().decode(bytes);
}
