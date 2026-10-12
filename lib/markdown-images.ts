export interface MarkdownImage { target: string; start: number; end: number }

/** Image spans outside code; balanced destinations preserve nested citation links. */
export function markdownImages(text: string): MarkdownImage[] {
  const images: MarkdownImage[] = [];
  for (let i = 0; i < text.length; i++) {
    if (i === 0 || text[i - 1] === "\n") {
      if (/^(?: {4}|\t)/.test(text.slice(i))) {
        const end=text.indexOf('\n',i);
        i=end<0?text.length:end;
        continue;
      }
      const fence = /^( {0,3})(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(text.slice(i));
      if (fence) {
        const close = new RegExp(`^ {0,3}${fence[2][0]}{${fence[2].length},}[ \\t\\r]*$`, "gm");
        close.lastIndex = i + fence[0].length;
        const end = close.exec(text);
        i = end ? end.index + end[0].length - 1 : text.length;
        continue;
      }
    }
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === "`") {
      const ticks = /^`+/.exec(text.slice(i))![0];
      let end = text.indexOf(ticks, i + ticks.length);
      while (end >= 0 && (text[end - 1] === "`" || text[end + ticks.length] === "`"))
        end = text.indexOf(ticks, end + ticks.length);
      if (end >= 0) i = end + ticks.length - 1;
      else i += ticks.length - 1;
      continue;
    }
    if (!text.startsWith("![", i)) continue;
    if (text.startsWith("![[", i)) {
      const end = text.indexOf("]]", i + 3);
      if (end < 0) continue;
      images.push({target: text.slice(i + 3, end).split("|")[0].trim(), start: i, end: end + 2});
      i = end + 1;
      continue;
    }
    let end = i + 2, brackets = 1;
    for (; end < text.length && brackets; end++) {
      if (text[end] === "\\") end++;
      else if (text[end] === "[") brackets++;
      else if (text[end] === "]") brackets--;
    }
    if (brackets || text[end] !== "(") continue;
    const opening = end++;
    while (/\s/.test(text[end] ?? "") && end < text.length) end++;
    const targetStart = end;
    let targetEnd = end, depth = 1, angle = false, quote = "";
    for (; end < text.length && depth; end++) {
      const char = text[end];
      if (char === "\\") { end++; continue; }
      if (quote) { if (char === quote) quote = ""; continue; }
      if (angle) { if (char === ">") angle = false; continue; }
      if (char === "<" && end === targetStart) { angle = true; continue; }
      if ((char === '"' || char === "'") && targetEnd > targetStart) { quote = char; continue; }
      if (char === "(") depth++;
      if (char === ")") depth--;
      if (!targetEnd || targetEnd === targetStart) {
        if (depth === 0 || (/\s/.test(char) && depth === 1)) targetEnd = end;
      }
    }
    if (depth) continue;
    const destination = text.slice(targetStart, targetEnd > targetStart ? targetEnd : end - 1);
    const target = destination.startsWith("<") ? destination.slice(1, -1) : destination;
    if (target && opening < end) images.push({target: target.replace(/\\([\\()<> ])/g, "$1"), start: i, end});
    i = end - 1;
  }
  return images;
}

/** Remove only selected image syntax, leaving all surrounding authored text untouched. */
export function omitMarkdownImages(text: string, omit: (target: string) => boolean): string {
  let result = "", offset = 0;
  for (const image of markdownImages(text)) {
    if (!omit(image.target)) continue;
    result += text.slice(offset, image.start);
    offset = image.end;
  }
  return result + text.slice(offset);
}
