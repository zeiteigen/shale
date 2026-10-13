export type GraphViewMode = 'organic' | 'classic';
export interface GraphForces { center: number; repel: number; link: number; distance: number }
export const DEFAULT_FORCES: GraphForces = { center: .01, repel: 300, link: 1, distance: 100 };
export const FORCE_CONTROLS = [
  { key: 'center', label: 'Center force', min: 0, max: .1, step: .001 },
  { key: 'repel', label: 'Repel force', min: 0, max: 1200, step: 10 },
  { key: 'link', label: 'Link force', min: 0, max: 2, step: .05 },
  { key: 'distance', label: 'Link distance', min: 40, max: 240, step: 5 },
] as const;
const STORAGE_KEY = 'shale.knowledge.graph.v1';
export interface GraphPreferences { mode: GraphViewMode; forces: GraphForces }

export function readGraphPreferences(): GraphPreferences {
  const defaults: GraphPreferences = { mode: 'organic', forces: { ...DEFAULT_FORCES } };
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (!stored || typeof stored !== 'object') return defaults;
    if (stored.mode === 'classic') defaults.mode = 'classic';
    for (const { key, min, max } of FORCE_CONTROLS) {
      const value = stored.forces?.[key];
      if (typeof value === 'number' && Number.isFinite(value)) defaults.forces[key] = Math.max(min, Math.min(max, value));
    }
  } catch { /* Storage may be disabled or contain an older value. */ }
  return defaults;
}

export function saveGraphPreferences(preferences: GraphPreferences) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)); } catch { /* The graph remains usable without storage. */ }
}
