import type { MapPoint } from './graph-layout';
import type { MapView } from './graph-paint';

/** Organic coordinates are unbounded; camera offsets are in world units. */
export function organicTransform(view: MapView) {
  return { scale: view.zoom, x: view.width / 2 - view.x * view.zoom, y: view.height / 2 - view.y * view.zoom };
}

export function fitOrganicGraph(points: Iterable<MapPoint>, view: MapView) {
  let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
  for (const p of points) {
    left = Math.min(left, p.x - p.radius); right = Math.max(right, p.x + p.radius);
    top = Math.min(top, p.y - p.radius); bottom = Math.max(bottom, p.y + p.radius);
  }
  if (!Number.isFinite(left)) { view.x = view.y = 0; view.zoom = 1; return; }
  view.zoom = Math.max(.01, Math.min(1, Math.max(40, view.width - 64) / Math.max(80, right - left), Math.max(40, view.height - 220) / Math.max(80, bottom - top)));
  view.x = (left + right) / 2; view.y = (top + bottom) / 2 - 5 / view.zoom;
}
