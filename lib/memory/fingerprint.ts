import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";

/** Hash UTF-8 source text when the original source is already available as text. */
export function fingerprintText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Hash original file bytes without retaining the file in memory. */
export async function fingerprintFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
