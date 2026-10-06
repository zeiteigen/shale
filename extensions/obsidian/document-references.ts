import { isDocumentFile } from "./document-files";

export interface DocumentReference {
  target: string;
  raw: string;
  alias?: string;
  heading?: string;
  position: number;
  embedded: boolean;
}

/** Preserve PDF page anchors, aliases, and authored evidence on document links. */
export function parseDocumentReferences(body: string): DocumentReference[] {
  const references: DocumentReference[] = [];
  const add = (destination: string, raw: string, position: number, embedded: boolean, alias?: string) => {
    const [target, ...anchor] = destination.trim().split("#");
    if (!isDocumentFile(target)) return;
    references.push({ target, raw, position, embedded, alias, heading: anchor.join("#") || undefined });
  };
  for (const match of body.matchAll(/(!?)\[\[(.*?)\]\]/g)) {
    const [destination, alias] = match[2].split("|");
    add(destination, match[0], match.index, !!match[1], alias);
  }
  for (const match of body.matchAll(/(!?)\[(?!\[)([^\]]*)\]\(([^)]+)\)/g)) {
    let destination = match[3].trim().replace(/^<(.*)>$/, "$1");
    try { destination = decodeURI(destination); } catch {}
    add(destination, match[0], match.index, !!match[1], match[2]);
  }
  return references.sort((a, b) => a.position - b.position);
}
