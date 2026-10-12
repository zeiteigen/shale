import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import type { GraphForces } from './graph-preferences';

export interface ForceNode extends SimulationNodeDatum { id: number; radius: number }
export interface ForceEdge { source: number; target: number }

/** Physics owns copies: D3 mutates both nodes and link endpoints. */
export function createGraphSimulation(input: ForceNode[], inputEdges: ForceEdge[], settings: GraphForces) {
  const nodes = input.map(node => ({ ...node })).sort((a, b) => a.id - b.id);
  const ids = new Set(nodes.map(node => node.id));
  const unique = new Map<string, ForceEdge>();
  for (const { source, target } of inputEdges) if (source !== target && ids.has(source) && ids.has(target)) {
    const a = Math.min(source, target), b = Math.max(source, target);
    unique.set(`${a}:${b}`, { source: a, target: b });
  }
  const edges = [...unique.values()].sort((a, b) => a.source - b.source || a.target - b.target);
  const degree = new Map<number, number>();
  for (const edge of edges) for (const id of [edge.source, edge.target]) degree.set(id, (degree.get(id) ?? 0) + 1);
  const simulation = forceSimulation(nodes).stop().velocityDecay(.45).alphaDecay(.025)
    .force('collision', forceCollide<ForceNode>(node => node.radius + 10).iterations(2));
  function configure(forces: GraphForces) {
    simulation
      .force('repel', forceManyBody<ForceNode>().strength(-forces.repel))
      .force('x', forceX<ForceNode>(0).strength(forces.center))
      .force('y', forceY<ForceNode>(0).strength(forces.center))
      .force('link', forceLink<ForceNode, SimulationLinkDatum<ForceNode>>(edges.map(edge => ({ ...edge }))).id(node => node.id)
        .distance(forces.distance).strength(edge => {
          const source = typeof edge.source === 'object' ? edge.source.id : Number(edge.source);
          const target = typeof edge.target === 'object' ? edge.target.id : Number(edge.target);
          return forces.link / Math.max(1, Math.min(degree.get(source) ?? 1, degree.get(target) ?? 1));
        }));
    simulation.alpha(.6);
  }
  configure(settings);
  return { simulation, configure };
}
