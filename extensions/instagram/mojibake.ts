/**
 * Instagram's JSON export writes UTF-8 bytes as if each were a Latin-1 code point
 * ("cafÃ©" for "café"). Re-decode only strings that are byte-shaped and decode cleanly.
 */
export function fixMojibake(text: string): string {
  if (!/[\u0080-ÿ]/.test(text) || /[^\u0000-ÿ]/.test(text)) return text;
  const decoded = Buffer.from(text, "latin1").toString("utf8");
  return decoded.includes("�") ? text : decoded;
}

export function fixMojibakeDeep<T>(value: T): T {
  if (typeof value === "string") return fixMojibake(value) as T;
  if (Array.isArray(value)) return value.map(fixMojibakeDeep) as T;
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fixMojibakeDeep(item)])) as T;
  return value;
}
