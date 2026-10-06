import type { PageBlock } from "../../lib/browser-contract";
/** Every chunk has an observed section locator and a hard character bound. */
export function chunkBlocks(blocks: PageBlock[], size = 1000) {
  const limit = Math.max(1, Math.floor(size));
  const chunks: Array<{
    text: string;
    locator: string;
    headingPath: string[];
  }> = [];
  for (const block of blocks) {
    for (let offset = 0; offset < block.text.length;) {
      let end = Math.min(block.text.length, offset + limit);
      if (end < block.text.length && block.kind !== "code") {
        const boundary = block.text.lastIndexOf(" ", end);
        if (boundary > offset + limit / 2) end = boundary;
      }
      const text = block.text.slice(offset, end);
      if (text.trim())
        chunks.push({
          text,
          locator: `${block.locator}:${offset}-${end}`,
          headingPath: block.headingPath,
        });
      offset = end;
      if (block.kind !== "code") while (block.text[offset] === " ") offset++;
    }
  }
  return chunks;
}
