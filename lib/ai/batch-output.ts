/** Batch output is unordered. Reject errors, missing IDs, and duplicate IDs before exposing results. */
export function parseBatchOutput<T>(content: string, count: number): T[] {
  const results = new Array<T>(count);
  const seen = new Set<number>();
  for (const line of content.split("\n").filter(line => line.trim())) {
    const item = JSON.parse(line);
    const match = typeof item.custom_id === "string" && /^request-(\d+)$/.exec(item.custom_id);
    const index = match ? Number(match[1]) : -1;
    if (index < 0 || index >= count || seen.has(index))
      throw new Error("Batch output has invalid or duplicate request IDs");
    if (item.error || !item.response || item.response.status_code < 200 || item.response.status_code >= 300)
      throw new Error(`Batch request ${item.custom_id} failed: ${item.error?.message ?? item.response?.body?.error?.message ?? item.response?.status_code}`);
    if (!item.response.body) throw new Error(`Batch request ${item.custom_id} has no response body`);
    seen.add(index);
    results[index] = item.response.body;
  }
  if (seen.size !== count) throw new Error(`Batch output must contain exactly ${count} responses`);
  return results;
}
