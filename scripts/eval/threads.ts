import type { Database } from 'bun:sqlite';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Golden threads (resources/graph-eval.json), shared by scripts/graph-eval.ts (are they connected?) and
 * scripts/search-eval.ts (does the thread name find its members?). Members match by origin and title/uri/text globs.
 */
export interface Member { label: string; origin?: string; title?: string; uri?: string; text?: string }
export interface Thread { name: string; description?: string; members: Member[] }

export function matchMember(db: Database, member: Member) {
  const where = ['1'], params: string[] = [];
  if (member.origin) { where.push('s.origin=?'); params.push(member.origin); }
  if (member.title) { where.push('s.title GLOB ?'); params.push(member.title); }
  if (member.uri) { where.push('s.uri GLOB ?'); params.push(member.uri); }
  if (member.text) { where.push('EXISTS(SELECT 1 FROM chunks c WHERE c.source_id=s.id AND c.text_content GLOB ?)'); params.push(member.text); }
  return db.query<{ id: string; title: string }, string[]>(`SELECT s.id,s.title FROM sources s WHERE ${where.join(' AND ')} ORDER BY s.created_at`).all(...params);
}

/** A missing, empty, or thread-less file yields no threads plus a note saying why. */
export function loadThreads(path: string): { threads: Thread[]; note?: string } {
  const text = existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
  if (!text) return { threads: [], note: `no golden threads configured (${path} is ${existsSync(path) ? 'empty' : 'missing'})` };
  const threads = (JSON.parse(text) as { threads?: Thread[] }).threads ?? [];
  return threads.length ? { threads } : { threads, note: `no golden threads configured in ${path}` };
}
