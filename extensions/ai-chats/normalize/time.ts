/** Epoch ms from epoch seconds, epoch ms, or an ISO string; undefined when unusable. */
export function toMs(value: unknown): number | undefined {
  let ms: number | undefined;
  if (typeof value === "number" && Number.isFinite(value)) ms = value < 1e12 ? value * 1000 : value;
  else if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) ms = parsed;
  }
  return ms !== undefined && ms >= 0 ? Math.round(ms) : undefined;
}
