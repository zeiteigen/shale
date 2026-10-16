import type { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Shared helpers for the read-only replay evaluations in scripts/llm-replacement-eval.ts. */
export const hasTable = (db: Database, table: string) => Boolean(db.query("SELECT 1 FROM sqlite_master WHERE name=?").get(table));

/** Entity id -> root of its merge group (canonical_id chains), loaded once; merged mentions compare as their root. */
export function canonicalRoots(db: Database): (id: number) => number {
  const parent = new Map<number, number>();
  for (const row of db.query<{ id: number; canonical_id: number }, []>('SELECT id,canonical_id FROM entities WHERE canonical_id IS NOT NULL').all())
    parent.set(row.id, row.canonical_id);
  const memo = new Map<number, number>();
  return function root(id: number): number {
    const known = memo.get(id); if (known !== undefined) return known;
    let at = id; const seen = new Set<number>();
    while (parent.has(at) && !seen.has(at)) { seen.add(at); at = parent.get(at)!; }
    memo.set(id, at); return at;
  };
}

export const ratio = (a: number, b: number) => b ? a / b : null;
export const pct = (value: number | null | undefined) => value == null ? '-' : `${(100 * value).toFixed(1)}%`;

/**
 * Import an optional module by path (relative to the repo root) and pick the first export that exists.
 * Later phases add these modules concurrently, so a missing file or export is a skip, not an error;
 * a module that exists but fails to load is reported so a broken implementation is not mistaken for an absent one.
 */
export async function optionalExport<T>(paths: string[], names: string[]): Promise<{ value: T; path: string; name: string } | { skipped: string }> {
  const reasons: string[] = [];
  for (const path of paths) {
    const absolute = resolve(import.meta.dir, '../..', path);
    if (!existsSync(absolute)) { reasons.push(`${path} not found`); continue; }
    let module: Record<string, unknown>;
    try { module = await import(absolute); }
    catch (error) { reasons.push(`${path} failed to load: ${error instanceof Error ? error.message : String(error)}`); continue; }
    for (const name of names) if (typeof module[name] === 'function') return { value: module[name] as T, path, name };
    reasons.push(`${path} exports none of ${names.join(', ')}`);
  }
  return { skipped: reasons.join('; ') };
}
