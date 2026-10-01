import type { GraphValue } from "./types";

export function validateValue(value: GraphValue, depth = 0): void {
  if (depth > 32) throw new Error('Graph value exceeds nesting limit');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach(item=>validateValue(item,depth+1)); return; }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    Object.values(value).forEach(item=>validateValue(item,depth+1)); return;
  }
  throw new Error('Graph values must contain only JSON values and finite numbers');
}

/** Stable object-key order makes equivalent structured values compare equally. */
export function serializeValue(value: GraphValue): string {
  const normalized = (item: GraphValue): GraphValue => {
    if (Array.isArray(item)) return item.map(normalized);
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b)).map(([key,val])=>[key,normalized(val)]));
    return item;
  };
  return JSON.stringify(normalized(value));
}
