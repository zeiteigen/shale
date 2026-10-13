import type { GraphNode } from "./types";

const normalize = (text: string) => text.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();

/** Entity names remain searchable even when an MCP-created entry has no source chunks. */
export function searchGraphNodes(nodes: GraphNode[], query: string, limit = 8) {
  const text = normalize(query.trim()), terms = text.split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return nodes.map(node => ({ node, name: normalize(node.name), text: normalize(`${node.name} ${node.type} ${node.namespace}`) }))
    .filter(entry => terms.every(term => entry.text.includes(term)))
    .sort((a, b) => Number(b.name === text) - Number(a.name === text)
      || Number(b.name.startsWith(text)) - Number(a.name.startsWith(text)) || a.node.name.localeCompare(b.node.name))
    .slice(0, limit).map(entry => entry.node);
}
