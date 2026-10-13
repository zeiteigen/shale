import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';
import type { GraphData, GraphNode } from './types';
import type { GraphForces } from './graph-preferences';
import { graphAdjacency, visibleGraph } from './graph-visibility';
import { paintGraph } from './graph-paint';
import { fitOrganicGraph, organicTransform } from './organic-camera';
import { useForceLayout, type OrganicSession } from './use-force-layout';

interface Gesture { x: number; y: number; offsetX: number; offsetY: number; node?: number; nodeX: number; nodeY: number; moved: boolean }

export const OrganicGraphMap = memo(function OrganicGraphMap({ data, selected, visibleTypes, focusSelection, connectionDepth, onSelect, forces, session }: {
  data: GraphData; selected: GraphNode | null; visibleTypes: Set<string>; focusSelection: boolean; connectionDepth: number;
  onSelect: (node: GraphNode) => void; forces: GraphForces; session: OrganicSession;
}) {
  const canvas = useRef<HTMLCanvasElement>(null), frame = useRef<number | undefined>(undefined);
  const runtime = useRef<ReturnType<typeof useForceLayout> | null>(null), gesture = useRef<Gesture | null>(null);
  const selectedId = useRef(selected?.id); selectedId.current = selected?.id;
  const hovered = useRef<number | undefined>(undefined);
  const [hover, setHover] = useState(''), [zoom, setZoom] = useState(session.camera.zoom);
  const adjacency = useMemo(() => graphAdjacency(data), [data]);
  const focusId = focusSelection ? selected?.id : undefined;
  const graph = useMemo(() => visibleGraph(data, adjacency, visibleTypes, focusId, focusSelection, connectionDepth), [data, adjacency, visibleTypes, focusId, focusSelection, connectionDepth]);
  const draw = useCallback(() => {
    if (frame.current !== undefined) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      if (canvas.current && runtime.current) paintGraph(canvas.current, runtime.current.layout.current, session.camera, selectedId.current, { transform: organicTransform(session.camera), hover: hovered.current });
    });
  }, [session]);
  const update = useCallback((done: boolean) => {
    if (done && session.needsFit && session.camera.width > 1 && runtime.current) {
      fitOrganicGraph(runtime.current.layout.current.points.values(), session.camera); session.needsFit = false; setZoom(session.camera.zoom);
    }
    draw();
  }, [draw, session]);
  const simulation = useForceLayout(graph, forces, session, focusSelection && focusId !== undefined ? `${focusId}:${connectionDepth}` : 'all', update);
  runtime.current = simulation;

  useEffect(() => {
    const element = canvas.current!;
    const resize = () => {
      const rect = element.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
      session.camera.width = rect.width; session.camera.height = rect.height;
      element.width = Math.round(rect.width * dpr); element.height = Math.round(rect.height * dpr);
      if (session.needsFit && (runtime.current?.settled || graph.nodes.length <= 1)) update(true); else draw();
    };
    const observer = new ResizeObserver(resize); observer.observe(element); resize();
    return () => { observer.disconnect(); if (frame.current !== undefined) cancelAnimationFrame(frame.current); frame.current = undefined; };
  }, [draw, update, session, graph.nodes.length]);
  useEffect(() => { draw(); }, [selected?.id, draw]);

  const changeZoom = useCallback((next: number, x = session.camera.width / 2, y = session.camera.height / 2) => {
    const view = session.camera, t = organicTransform(view);
    const worldX = (x - t.x) / t.scale, worldY = (y - t.y) / t.scale;
    view.zoom = Math.max(.01, Math.min(8, next));
    view.x = worldX - (x - view.width / 2) / view.zoom; view.y = worldY - (y - view.height / 2) / view.zoom;
    session.needsFit = false; setZoom(view.zoom); draw();
  }, [draw, session]);
  useEffect(() => {
    const element = canvas.current!;
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); const rect = element.getBoundingClientRect();
      changeZoom(session.camera.zoom * (event.deltaY < 0 ? 1.14 : .88), event.clientX - rect.left, event.clientY - rect.top);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [changeZoom, session]);

  function point(event: { clientX: number; clientY: number }) {
    const rect = canvas.current!.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
  function hit(p: { x: number; y: number }) {
    const t = organicTransform(session.camera); let nearest: GraphNode | undefined, distance = Infinity;
    for (const entry of simulation.layout.current.points.values()) {
      const d = Math.hypot(p.x - (entry.x * t.scale + t.x), p.y - (entry.y * t.scale + t.y));
      if (d < Math.max(6, entry.radius * t.scale + 3) && d < distance) { nearest = entry.node; distance = d; }
    }
    return nearest;
  }
  function finish(cancelled: boolean) {
    const start = gesture.current;
    if (start?.node !== undefined && start.moved) {
      const entry = simulation.layout.current.points.get(start.node);
      if (entry) simulation.moveNode(start.node, entry.x, entry.y, true);
    } else if (start && !start.moved && !cancelled && start.node !== undefined) {
      const node = simulation.layout.current.points.get(start.node)?.node; if (node) onSelect(node);
    }
    gesture.current = null;
  }
  return <div className="map-scroll organic-map">
    <div className="map-controls" aria-label="Graph zoom controls">
      <button onClick={() => changeZoom(session.camera.zoom * 1.2)} aria-label="Zoom in"><Plus size={16} /></button>
      <button onClick={() => changeZoom(session.camera.zoom / 1.2)} aria-label="Zoom out"><Minus size={16} /></button>
      <button onClick={() => { fitOrganicGraph(simulation.layout.current.points.values(), session.camera); session.needsFit = false; setZoom(session.camera.zoom); draw(); }} aria-label="Reset graph view"><RotateCcw size={14} /></button>
      <span>{Math.round(zoom * 100)}%</span>
    </div>
    <canvas ref={canvas} className="graph-map" data-layout="organic" data-node-count={graph.nodes.length} aria-busy={!simulation.settled} role="img" tabIndex={0}
      aria-label="Knowledge graph map. Scroll to zoom, drag empty space to pan, drag a node to move it, click an entry to inspect it. Use arrow keys to select entries."
      onPointerDown={event => {
        if (event.button !== 0) return;
        const p = point(event), node = hit(p), entry = node && simulation.layout.current.points.get(node.id);
        gesture.current = { ...p, offsetX: session.camera.x, offsetY: session.camera.y, node: node?.id, nodeX: entry?.x ?? 0, nodeY: entry?.y ?? 0, moved: false };
        event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => {
        const p = point(event), start = gesture.current;
        if (start) {
          if (Math.hypot(p.x - start.x, p.y - start.y) > 4) start.moved = true;
          if (!start.moved) return;
          session.needsFit = false;
          if (start.node !== undefined) simulation.moveNode(start.node, start.nodeX + (p.x - start.x) / session.camera.zoom, start.nodeY + (p.y - start.y) / session.camera.zoom, false);
          else { session.camera.x = start.offsetX - (p.x - start.x) / session.camera.zoom; session.camera.y = start.offsetY - (p.y - start.y) / session.camera.zoom; draw(); }
        } else {
          const node = hit(p); if (hovered.current === node?.id) return;
          hovered.current = node?.id; setHover(node ? `${node.name} · ${node.type}` : ''); draw();
        }
      }}
      onPointerUp={event => { finish(false); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={() => finish(true)} onLostPointerCapture={() => finish(true)}
      onPointerLeave={() => { hovered.current = undefined; setHover(''); draw(); }}
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || !graph.nodes.length) return;
        event.preventDefault(); const current = graph.nodes.findIndex(node => node.id === selected?.id), step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
        onSelect(graph.nodes[(current + step + graph.nodes.length) % graph.nodes.length]);
      }} />
    {hover && <div className="map-hover" role="status">{hover}</div>}
    {simulation.error ? <div className="graph-message error-note" role="alert">{simulation.error}</div> : !graph.nodes.length ? <div className="graph-message" role="status">No entries match these filters.</div> : !simulation.settled ? <div className="graph-arranging" role="status">Arranging graph…</div> : null}
  </div>;
});
