import type { GraphData, GraphNode } from './types';

export function graphAdjacency(data: GraphData) {
  const adjacency = new Map<number, number[]>();
  for (const edge of data.edges) for (const [from,to] of [[edge.source,edge.target],[edge.target,edge.source]]) {
    let neighbors=adjacency.get(from);
    if (!neighbors) adjacency.set(from,neighbors=[]);
    neighbors.push(to);
  }
  return adjacency;
}

export function graphLayout(data: GraphData, adjacency: Map<number,number[]>, types: Set<string>, selected: number | undefined, focus: boolean, depth: number) {
  let included: Set<number> | undefined;
  if (focus && selected !== undefined) {
    included=new Set([selected]);let frontier=[selected];
    for(let degree=0;degree<depth;degree++) {
      const next:number[]=[];
      for(const id of frontier) for(const neighbor of adjacency.get(id) ?? []) if(!included.has(neighbor)) {included.add(neighbor);next.push(neighbor);}
      frontier=next;
    }
  }
  const nodes=data.nodes.filter(n=>(!included || included.has(n.id)) && (types.has(n.type) || included && n.id===selected));
  const cols=Math.max(6,Math.ceil(Math.sqrt(nodes.length*1.5)));
  const points=new Map(nodes.map((node,index)=>[node.id,{node,x:58+(index%cols)*86+((node.id*37)%19)-9,y:54+Math.floor(index/cols)*66+((node.id*17)%13),radius:Math.min(13,5+Math.sqrt(node.degree || 1))}]));
  const edges=data.edges.filter(edge=>points.has(edge.source)&&points.has(edge.target));
  return {nodes,points,edges,width:Math.max(720,cols*86+116),height:Math.max(480,Math.ceil(nodes.length/cols)*66+116)};
}

export type MapLayout=ReturnType<typeof graphLayout>;
export type MapPoint={node:GraphNode;x:number;y:number;radius:number};
