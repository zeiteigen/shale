import type { ForceEdge, ForceNode } from './graph-force';
import type { GraphForces } from './graph-preferences';

export type GraphWorkerRequest =
  | { kind: 'init'; revision: number; nodes: ForceNode[]; edges: ForceEdge[]; forces: GraphForces; reducedMotion: boolean }
  | { kind: 'forces'; revision: number; forces: GraphForces }
  | { kind: 'drag'; revision: number; id: number; x: number; y: number; release: boolean }
  | { kind: 'pause'; paused: boolean };
export interface GraphWorkerSnapshot { revision: number; positions: Float64Array; settled: boolean }
