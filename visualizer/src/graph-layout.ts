import type { GraphData, GraphNode } from './types';
import { visibleGraph } from './graph-visibility';
export { graphAdjacency } from './graph-visibility';

export function graphLayout(data: GraphData, adjacency: Map<number,number[]>, types: Set<string>, selected: number | undefined, focus: boolean, depth: number) {
  const {nodes,edges}=visibleGraph(data,adjacency,types,selected,focus,depth);
  const cols=Math.max(6,Math.ceil(Math.sqrt(nodes.length*1.5)));
  const points=new Map(nodes.map((node,index)=>[node.id,{node,x:58+(index%cols)*86+((node.id*37)%19)-9,y:54+Math.floor(index/cols)*66+((node.id*17)%13),radius:Math.min(13,5+Math.sqrt(node.degree || 1))}]));
  return {nodes,points,edges,width:Math.max(720,cols*86+116),height:Math.max(480,Math.ceil(nodes.length/cols)*66+116)};
}

export type MapLayout=ReturnType<typeof graphLayout>;
export type MapPoint={node:GraphNode;x:number;y:number;radius:number};
