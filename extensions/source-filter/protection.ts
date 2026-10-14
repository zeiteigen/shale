import type { ShaleSDK } from '@shale/sdk';
import { graphIdentityFromSourceUri } from '../../lib/source-identity';
import type { SourceFilterSettings } from './settings.types';
import type { FilterSource } from './types';

const PROTECTED_TYPES = new Set(['bookmark', 'browser_bookmark', 'note', 'markdown_note', 'document',
  'pdf', 'image', 'file', 'text']);

function matches(uri: string, pattern: string): boolean {
  return new RegExp('^' + pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'iu').test(uri);
}

/** Incremental exact audit references; repeated removals do not rescan the whole audit history. */
export class SourceProtections {
  private ids = new Set<string>();
  private changeCursor = 0;
  private memoryCursor = 0;
  constructor(private sdk: ShaleSDK) {}

  curated(): Set<string> {
    const db = this.sdk.database;
    const changes = db.query<{ n: number }, []>('SELECT coalesce(max(rowid),0) AS n FROM graph_changes').get()!.n;
    const memories = db.query<{ n: number }, []>('SELECT coalesce(max(id),0) AS n FROM source_memory_changes').get()!.n;
    for (const row of db.query<{ source_id: string }, [number, number]>(`SELECT DISTINCT source_id FROM source_memory_changes
      WHERE id>? AND id<=? AND actor NOT LIKE 'extension:%'`).all(this.memoryCursor, memories)) this.ids.add(row.source_id);
    for (const row of db.query<{ source_id: string }, [number, number]>(`
      SELECT DISTINCT CAST(j.value AS TEXT) AS source_id FROM graph_changes c,json_tree(c.operations) j
      WHERE c.rowid>? AND c.rowid<=? AND c.actor NOT LIKE 'extension:%' AND j.type='text'
        AND (j.key='sourceId' OR (j.key='id' AND EXISTS(SELECT 1 FROM sources s WHERE s.id=j.value)))`)
      .all(this.changeCursor, changes)) this.ids.add(row.source_id);
    this.changeCursor = changes; this.memoryCursor = memories;
    return this.ids;
  }
}

export function protectionReason(source: FilterSource, settings: SourceFilterSettings, curated: Set<string>): string | null {
  if (!settings.origins.includes(source.origin)) return 'Origin is outside automatic-capture scope';
  if (PROTECTED_TYPES.has(source.type)) return 'Notes, local documents, and bookmarks are protected';
  if (curated.has(source.id)) return 'Explicitly curated or restored source';
  if (settings.protectedSourceIds.includes(source.id)) return 'Explicitly protected source ID';
  if (settings.protectedUriPatterns.some(pattern => matches(source.uri, pattern)
    || matches(graphIdentityFromSourceUri(source.uri), pattern))) return 'Explicitly protected URI';
  return null;
}
