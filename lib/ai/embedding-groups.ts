/** Bound synchronous inference work, including padding to the longest batch item.
 * Oversized individual texts stay intact and run alone. Never truncate source text.
 */
export function embeddingGroups(texts: string[], size: number, maxChars: number, instruction?: string): string[][] {
  const groups: string[][] = [];
  let group: string[] = [];
  let longest = 0;
  const prefixLength = instruction ? `Instruct: ${instruction}\nQuery: `.length : 0;
  for (const text of texts) {
    const length = text.length + prefixLength;
    const nextLongest = Math.max(longest, length);
    if (group.length && (group.length >= size || nextLongest * (group.length + 1) > maxChars)) {
      groups.push(group);
      group = [];
      longest = 0;
    }
    group.push(text);
    longest = Math.max(longest, length);
  }
  if (group.length) groups.push(group);
  return groups;
}
