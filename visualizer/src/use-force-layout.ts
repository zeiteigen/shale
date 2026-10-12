import { useEffect, useRef, useState } from 'react';
import type { MapLayout, MapPoint } from './graph-layout';
import type { MapView } from './graph-paint';
import type { GraphForces } from './graph-preferences';
import type { GraphWorkerRequest, GraphWorkerSnapshot } from './graph-worker-types';
import type { GraphEdge, GraphNode } from './types';

export interface OrganicSession {
  positions: Map<number, { x: number; y: number }>;
  camera: MapView;
  needsFit: boolean;
  focusKey: string;
}
export function createOrganicSession(): OrganicSession {
  return { positions: new Map(), camera: { width: 1, height: 1, zoom: 1, x: 0, y: 0 }, needsFit: true, focusKey: 'all' };
}

export function useForceLayout(graph: { nodes: GraphNode[]; edges: GraphEdge[] }, forces: GraphForces, session: OrganicSession, focusKey: string, onUpdate: (settled: boolean) => void) {
  const layout = useRef<MapLayout>({ nodes: [], edges: [], points: new Map(), width: 1, height: 1 });
  const worker = useRef<Worker | null>(null), revision = useRef(0);
  const heldNode = useRef<{ id: number; x: number; y: number } | null>(null);
  const currentForces = useRef(forces); currentForces.current = forces;
  const [settled, setSettled] = useState(false), [error, setError] = useState('');
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);

  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)'), update = () => setReducedMotion(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const generation = ++revision.current;
    heldNode.current = null;
    if (session.focusKey !== focusKey) { session.needsFit = true; session.focusKey = focusKey; }
    // Match D3's deterministic phyllotaxis seed; retain positions for hidden nodes too.
    const indices = new Map([...graph.nodes].sort((a, b) => a.id - b.id).map((node, index) => [node.id, index]));
    const points = new Map<number, MapPoint>(graph.nodes.map(node => {
      const index = indices.get(node.id)!, radius = 10 * Math.sqrt(.5 + index), angle = index * Math.PI * (3 - Math.sqrt(5));
      const position = session.positions.get(node.id) ?? { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
      return [node.id, { node, ...position, radius: Math.min(13, 5 + Math.sqrt(node.degree || 1)) }] as const;
    }));
    layout.current = { ...graph, points, width: 1, height: 1 };
    setError(''); setSettled(false);
    if (graph.nodes.length <= 1) {
      for (const point of points.values()) if (!session.positions.has(point.node.id)) point.x = point.y = 0;
      setSettled(true); onUpdate(true);
      return;
    }
    let active = true, instance: Worker;
    const failed = () => {
      if (!active) return;
      setError('Unable to arrange this graph. Switch to Classic to continue.'); setSettled(true);
      instance?.terminate(); worker.current = null;
    };
    try { instance = new Worker(new URL('./graph-worker.ts', import.meta.url), { type: 'module' }); }
    catch { failed(); return; }
    worker.current = instance;
    instance.onerror = failed; instance.onmessageerror = failed;
    instance.onmessage = (event: MessageEvent<GraphWorkerSnapshot>) => {
      if (!active || event.data.revision !== revision.current) return;
      const { positions, settled: done } = event.data;
      for (let i = 0; i < positions.length; i += 3) {
        const id = positions[i], x = positions[i + 1], y = positions[i + 2], point = layout.current.points.get(id);
        if (!point || !Number.isFinite(x) || !Number.isFinite(y)) continue;
        const held = heldNode.current?.id === id ? heldNode.current : { x, y };
        point.x = held.x; point.y = held.y; session.positions.set(id, { x: held.x, y: held.y });
      }
      if (done) setSettled(true);
      onUpdate(done);
    };
    const message: GraphWorkerRequest = { kind: 'init', revision: generation, forces: currentForces.current, reducedMotion,
      nodes: [...points.values()].map(p => ({ id: p.node.id, x: p.x, y: p.y, radius: p.radius })),
      edges: graph.edges.map(({ source, target }) => ({ source, target })) };
    instance.postMessage(message);
    const visibility = () => instance.postMessage({ kind: 'pause', paused: document.hidden } satisfies GraphWorkerRequest);
    visibility(); document.addEventListener('visibilitychange', visibility);
    onUpdate(false);
    return () => { active = false; instance.terminate(); if (worker.current === instance) worker.current = null; document.removeEventListener('visibilitychange', visibility); };
  }, [graph, session, focusKey, reducedMotion, onUpdate]);

  useEffect(() => {
    if (!worker.current) return;
    setSettled(false);
    worker.current.postMessage({ kind: 'forces', revision: revision.current, forces } satisfies GraphWorkerRequest);
  }, [forces]);

  function moveNode(id: number, x: number, y: number, release: boolean) {
    const point = layout.current.points.get(id);
    if (!point) return;
    heldNode.current = release ? null : { id, x, y };
    point.x = x; point.y = y; session.positions.set(id, { x, y });
    worker.current?.postMessage({ kind: 'drag', revision: revision.current, id, x, y, release } satisfies GraphWorkerRequest);
    if (worker.current) setSettled(false);
    onUpdate(false);
  }
  return { layout, moveNode, settled, error };
}
