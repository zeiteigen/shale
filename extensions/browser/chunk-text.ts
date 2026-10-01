/**
 * Splits text into chunks of target character size on sentence or paragraph boundaries.
 */
export function chunkText(
  text: string,
  targetChunkSize: number = 1000,
): string[] {
  const limit = Math.max(64, Math.floor(targetChunkSize));
  const clean = text.replace(/\r\n?/g, "\n").trim();
  if (!clean) return [""];
  if (clean.length <= limit) {
    return [clean];
  }

  const chunks: string[] = [];
  let currentChunk = "";
  const append = (piece: string) => {
    const value = piece.trim();
    if (!value) return;
    const separator = currentChunk ? " " : "";
    if (currentChunk.length + separator.length + value.length <= limit) {
      currentChunk += separator + value;
      return;
    }
    if (currentChunk) (chunks.push(currentChunk), (currentChunk = ""));
    if (value.length <= limit) {
      currentChunk = value;
      return;
    }

    // A DOM can contain enormous punctuation-free runs. Split those on words,
    // then hard-split any single token so the configured limit is guaranteed.
    for (const word of value.split(/\s+/)) {
      if (word.length > limit) {
        if (currentChunk) (chunks.push(currentChunk), (currentChunk = ""));
        for (let offset = 0; offset < word.length; offset += limit) {
          const part = word.slice(offset, offset + limit);
          if (part.length === limit) chunks.push(part);
          else currentChunk = part;
        }
      } else if (!currentChunk) {
        currentChunk = word;
      } else if (currentChunk.length + word.length + 1 <= limit) {
        currentChunk += ` ${word}`;
      } else {
        chunks.push(currentChunk);
        currentChunk = word;
      }
    }
  };

  for (const block of clean.split(/\n+/)) {
    for (const sentence of block.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [block])
      append(sentence);
  }
  if (currentChunk) chunks.push(currentChunk);
  return chunks.length > 0 ? chunks : [clean.slice(0, limit)];
}

