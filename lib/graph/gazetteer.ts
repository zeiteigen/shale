import type { Database } from 'bun:sqlite';
import { ensureStorySchema } from './story-schema';
import { typeFamily } from './ontology';
import { tagTemporal } from './temporal';

/**
 * Gazetteer entity linking: an Aho–Corasick automaton over the registry's surface forms (canonical names, plain,
 * search, and source aliases, acronym keys), matched on word tokens so every hit is a whole-word span of the
 * original text, which is free exact evidence. It replaces the model's `match` field for things the registry
 * already knows. Ambiguous surfaces ("Alex", "ACM") are resolved by context: the candidate whose graph neighbours
 * overlap most with the other entities linked in the same text wins; ties are dropped rather than guessed.
 */
export interface GazetteerEntry {
  entityId: number;
  type: string;
  surface: string;
  /** Normalised tokens of the surface. */
  tokens: string[];
  kind: 'name' | 'alias' | 'acronym';
  /** Acronym keys match only upper-case text ("NHPC", not "nhpc" inside a sentence). */
  upper: boolean;
}

export interface GazetteerMatch {
  entityId: number;
  type: string;
  /** Exact substring of the input at [start, end). */
  quote: string;
  start: number;
  end: number;
  surface: string;
  kind: GazetteerEntry['kind'];
  /** Every entity sharing this surface (more than one when context disambiguated it). */
  candidates: number[];
  basis: 'unique' | 'context';
}

export interface Token { norm: string; start: number; end: number }

const fold = (text: string) => text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

/** Word tokens with offsets into the original text; "&" stays inside a token so "AT&T" is one word. */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(/[\p{L}\p{M}\p{N}&]+/gu)) {
    const norm = fold(match[0]);
    if (norm) tokens.push({ norm, start: match.index!, end: match.index! + match[0].length });
  }
  return tokens;
}

/**
 * Words too common to name anything on their own. A single-token surface in this list never matches, and neither
 * does a multi-token surface made only of them ("Home Page", "The Team").
 */
export const COMMON_WORDS = new Set(`a about above account across action add after again against all also am an and any app apply are
  area around as ask at available back based be because been before being below best between both business but buy by call can
  care case center change check class click close code come company complete contact content continue could course create current
  data date day days de dear details did do does done down each early easy email end even event every experience explore fall
  family feature features file find first follow for form free friday from full get getting give go good great group guide had has
  have help her here hi high his home hour how i if important in info information into is it its job join just know last learn
  let life like link list live log login look love made mail make many may me meet meeting member message more most much my name
  need new news next no not note now of off offer office on one online only open or order other our out over page part people per
  plan please post power price privacy program project read ready really register report request research reply right role room
  save school search security see send service set share show sign site so some start state status still student students study
  subject submit support sure system take team terms than thank thanks that the their them then there these they thing this those
  through time to today together top update updates up upon us use user view want was way we web website week welcome well were
  what when where which who why will with work world would year yes you your monday tuesday wednesday thursday saturday sunday
  january february march april june july august september october november december morning evening night official general
  unsubscribe preferences notification notifications settings dashboard profile privacy policy inbox digest daily weekly summary`.split(/\s+/).filter(Boolean));

interface Node { next: Map<string, number>; fail: number; out: number[] }

/** Token-level Aho–Corasick over registry surfaces. Construction is linear in total surface tokens. */
export class Gazetteer {
  private nodes: Node[] = [{ next: new Map(), fail: 0, out: [] }];
  readonly entries: GazetteerEntry[] = [];

  constructor(entries: Iterable<GazetteerEntry>) {
    const seen = new Set<string>();
    for (const entry of entries) {
      if (!entry.tokens.length) continue;
      const id = `${entry.entityId}\u0000${entry.tokens.join(' ')}\u0000${entry.upper}`;
      if (seen.has(id)) continue;
      seen.add(id);
      let node = 0;
      for (const token of entry.tokens) {
        let next = this.nodes[node]!.next.get(token);
        if (next === undefined) {
          next = this.nodes.length;
          this.nodes.push({ next: new Map(), fail: 0, out: [] });
          this.nodes[node]!.next.set(token, next);
        }
        node = next;
      }
      this.nodes[node]!.out.push(this.entries.length);
      this.entries.push(entry);
    }
    // Breadth-first failure links; each node's outputs include those of its failure chain.
    const queue: number[] = [];
    for (const child of this.nodes[0]!.next.values()) queue.push(child);
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head]!;
      for (const [token, child] of this.nodes[current]!.next) {
        let fail = this.nodes[current]!.fail;
        while (fail && !this.nodes[fail]!.next.has(token)) fail = this.nodes[fail]!.fail;
        const target = this.nodes[fail]!.next.get(token);
        this.nodes[child]!.fail = target !== undefined && target !== child ? target : 0;
        this.nodes[child]!.out.push(...this.nodes[this.nodes[child]!.fail]!.out);
        queue.push(child);
      }
    }
  }

  get size() { return this.entries.length; }

  /** Every surface occurrence (overlapping, unfiltered by context) as token spans. */
  private scan(tokens: Token[]) {
    const hits: Array<{ entry: GazetteerEntry; first: number; last: number }> = [];
    let state = 0;
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!.norm;
      while (state && !this.nodes[state]!.next.has(token)) state = this.nodes[state]!.fail;
      state = this.nodes[state]!.next.get(token) ?? 0;
      for (const output of this.nodes[state]!.out) {
        const entry = this.entries[output]!;
        hits.push({ entry, first: index - entry.tokens.length + 1, last: index });
      }
    }
    return hits;
  }

  /**
   * Link registry entities mentioned in `text`. `context` lists entities already known to be involved (connector
   * participants, the venue); `neighbours` returns an entity's graph neighbours for disambiguation.
   */
  match(text: string, options: { context?: Iterable<number>; neighbours?: (ids: number[]) => Map<number, Set<number>> } = {}): GazetteerMatch[] {
    const tokens = tokenize(text);
    // Addresses and links are identified by keys, not names: "lenovo@ecomm.lenovo.com" must not read as "Lenovo".
    const masked = [...text.matchAll(/https?:\/\/[^\s<>"')\]]+|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}|\b[\w-]+(?:\.[\w-]+)*\.(?:com|org|net|edu|io|ai|dev|gov|co|ca|uk|app)\b(?:\/\S*)?/gu)]
      .map(match => [match.index!, match.index! + match[0].length] as const);
    const raw = this.scan(tokens).filter(({ entry, first, last }) => {
      const quote = text.slice(tokens[first]!.start, tokens[last]!.end);
      if (masked.some(([from, to]) => tokens[first]!.start < to && tokens[last]!.end > from)) return false;
      // Words of one name are separated by spaces or light punctuation, not "<", "|", or a line of markup.
      for (let index = first; index < last; index++)
        if (!/^[ \t\-–—.,:'’/()]{1,3}$/.test(text.slice(tokens[index]!.end, tokens[index + 1]!.start))) return false;
      if (entry.upper) return /\p{Lu}.*\p{Lu}/u.test(quote) && quote === quote.toUpperCase();
      // A one-word name must look like a name where it occurs: capitalised, or written exactly as registered.
      if (entry.tokens.length === 1) return /\p{Lu}|\d/u.test(quote) || quote === entry.surface;
      return true;
    });
    // Longest span first, then leftmost: "Northbridge High Performance Computing" beats "Northbridge".
    raw.sort((a, b) => (b.last - b.first) - (a.last - a.first) || a.first - b.first);
    const taken = new Uint8Array(tokens.length);
    const spans = new Map<string, { first: number; last: number; entries: GazetteerEntry[] }>();
    for (const hit of raw) {
      const key = `${hit.first}:${hit.last}`;
      const existing = spans.get(key);
      if (existing) { existing.entries.push(hit.entry); continue; }
      let free = true;
      for (let index = hit.first; index <= hit.last && free; index++) free = !taken[index];
      if (!free) continue;
      for (let index = hit.first; index <= hit.last; index++) taken[index] = 1;
      spans.set(key, { first: hit.first, last: hit.last, entries: [hit.entry] });
    }
    const context = new Set(options.context ?? []);
    const resolved: GazetteerMatch[] = [];
    const ambiguous: Array<{ span: { first: number; last: number; entries: GazetteerEntry[] }; ids: number[] }> = [];
    const emit = (span: { first: number; last: number; entries: GazetteerEntry[] }, entry: GazetteerEntry, ids: number[], basis: GazetteerMatch['basis']) => {
      const start = tokens[span.first]!.start, end = tokens[span.last]!.end;
      resolved.push({ entityId: entry.entityId, type: entry.type, quote: text.slice(start, end), start, end, surface: entry.surface,
        kind: entry.kind, candidates: ids, basis });
    };
    for (const span of spans.values()) {
      const ids = [...new Set(span.entries.map(entry => entry.entityId))];
      const entry = span.entries[0]!;
      // A lone first name is everyone's; it needs the context to say which person (or that one is present at all).
      const personWord = span.first === span.last && typeFamily(entry.type) === 'Person' && entry.kind !== 'acronym';
      if (ids.length === 1 && !personWord) emit(span, entry, ids, 'unique');
      else ambiguous.push({ span, ids });
    }
    if (ambiguous.length) {
      const known = new Set([...context, ...resolved.map(match => match.entityId)]);
      const neighbours = options.neighbours?.([...new Set(ambiguous.flatMap(item => item.ids))]) ?? new Map<number, Set<number>>();
      for (const { span, ids } of ambiguous) {
        const scored = ids.map(id => {
          let score = context.has(id) ? 2 : 0;
          for (const other of neighbours.get(id) ?? []) if (other !== id && known.has(other)) score++;
          return { id, score };
        }).sort((a, b) => b.score - a.score);
        const [best, second] = scored;
        if (!best || best.score === 0 || (second && second.score === best.score)) continue;
        emit(span, span.entries.find(entry => entry.entityId === best.id)!, ids, 'context');
      }
    }
    return resolved.sort((a, b) => a.start - b.start);
  }
}

const MAX_TOKENS = 8;

/** Turn a registry name into a gazetteer entry, or null when it is too generic to link on sight. */
export function surfaceEntry(entityId: number, type: string, surface: string, kind: GazetteerEntry['kind']): GazetteerEntry | null {
  const clean = surface.trim();
  if (!clean || clean.length > 80 || /^entity:|:\/\/|@/.test(clean)) return null;
  // Model-made "entities" named after a date ("June 1, 2026") would link every mention of that date.
  if (tagTemporal(clean).some(mention => mention.offset === 0 && mention.quote.length >= clean.replace(/[.\s]+$/, '').length)) return null;
  if (kind === 'acronym') {
    const token = fold(clean);
    return /^[\p{L}\p{N}&]{3,8}$/u.test(token) && !COMMON_WORDS.has(token) ? { entityId, type, surface: clean, tokens: [token], kind, upper: true } : null;
  }
  const tokens = tokenize(clean).map(token => token.norm);
  if (!tokens.length || tokens.length > MAX_TOKENS || tokens.every(token => /^\d+$/.test(token))) return null;
  if (tokens.every(token => COMMON_WORDS.has(token) || token.length < 2)) return null;
  if (tokens.length === 1) {
    const token = tokens[0]!;
    // Short words are acronyms only when written in capitals ("AI", "NHPC"); otherwise they are noise.
    const capitals = /^[\p{Lu}\p{N}&]{2,8}$/u.test(clean) && /\p{Lu}/u.test(clean);
    if (capitals) return { entityId, type, surface: clean, tokens, kind, upper: true };
    if (token.length < 3) return null;
    // Lower-case single words ("network", "src") are vocabulary, not names. A one-word alias must also look
    // distinctive (inner capitals or digits: "SUMMER15", "iPhone"), since a capitalised alias such as "Resume" or
    // "Outlet" is usually a model's label for something generic.
    if (/^[\p{Ll}'-]+$/u.test(clean)) return null;
    if (kind === 'alias' && !/^.+\p{Lu}|\d/u.test(clean)) return null;
  }
  return { entityId, type, surface: clean, tokens, kind, upper: false };
}

/** Build from the registry: canonical, unretired entities indexed in entity_registry_fts (Episodes excluded). */
export function buildGazetteer(db: Database): Gazetteer {
  ensureStorySchema(db);
  const registry = new Map(db.query<{ id: number; type: string; name: string }, []>(`SELECT e.id,e.type,coalesce(e.display_name,e.name) AS name
    FROM entity_registry_fts f JOIN entities e ON e.id=f.rowid WHERE e.canonical_id IS NULL AND e.type!='Episode'
    AND NOT EXISTS(SELECT 1 FROM graph_entity_retirements r WHERE r.entity_id=e.id)`).all().map(row => [row.id, row]));
  // Merged members contribute their names and aliases to their canonical.
  const parent = new Map(db.query<{ id: number; canonical_id: number }, []>('SELECT id,canonical_id FROM entities WHERE canonical_id IS NOT NULL').all()
    .map(row => [row.id, row.canonical_id]));
  const canonical = (id: number) => {
    let current = id;
    for (let depth = 0; depth < 32 && parent.has(current); depth++) current = parent.get(current)!;
    return current;
  };
  const entries: GazetteerEntry[] = [];
  const add = (id: number, surface: string, kind: GazetteerEntry['kind']) => {
    const target = registry.get(canonical(id));
    const entry = target && surfaceEntry(target.id, target.type, surface, kind);
    if (entry) entries.push(entry);
  };
  for (const row of registry.values()) add(row.id, row.name, 'name');
  for (const row of db.query<{ id: number; name: string }, []>(`SELECT id,coalesce(display_name,name) AS name FROM entities
    WHERE canonical_id IS NOT NULL`).all()) add(row.id, row.name, 'name');
  for (const row of db.query<{ entity_id: number; alias: string; scope: string }, []>(`SELECT entity_id,alias,scope FROM graph_aliases
    WHERE scope IN ('','search','key:acronym') OR scope GLOB 'source:*'`).all())
    add(row.entity_id, row.alias, row.scope === 'key:acronym' ? 'acronym' : 'alias');
  return new Gazetteer(entries);
}

/**
 * Registry change counter: anything that adds a name, merges or unmerges, retires, or reindexes changes it.
 * Cheap enough to check before every use, so the cached automaton is never stale.
 */
function registryStamp(db: Database) {
  try { return rowidStamp(db); }
  catch {
    // Scoped connections shadow graph_aliases with a TEMP view, which has no rowid.
    const row = db.query<{ stamp: string }, []>(`SELECT (SELECT count(*) FROM entities)||':'||coalesce((SELECT max(id) FROM entities),0)
      ||':'||(SELECT count(*) FROM graph_aliases)||':'||coalesce((SELECT max(entity_id) FROM graph_aliases),0)
      ||':'||(SELECT count(*) FROM entities WHERE canonical_id IS NOT NULL)||':'||(SELECT count(*) FROM graph_entity_retirements) AS stamp`).get();
    return row?.stamp ?? '';
  }
}

function rowidStamp(db: Database) {
  const row = db.query<{ stamp: string }, []>(`SELECT (SELECT count(*) FROM entity_registry_fts)||':'||coalesce((SELECT max(rowid) FROM entity_registry_fts),0)
    ||':'||coalesce((SELECT max(rowid) FROM graph_aliases),0)||':'||(SELECT count(*) FROM graph_aliases)
    ||':'||(SELECT count(*) FROM entities WHERE canonical_id IS NOT NULL)||':'||(SELECT count(*) FROM graph_entity_retirements) AS stamp`).get();
  return row?.stamp ?? '';
}

const cache = new WeakMap<Database, { stamp: string; gazetteer: Gazetteer }>();

/** The process-wide gazetteer for a database, rebuilt only when the registry changed since the last build. */
export function gazetteerFor(db: Database): Gazetteer {
  ensureStorySchema(db);
  const stamp = registryStamp(db);
  const cached = cache.get(db);
  if (cached && cached.stamp === stamp) return cached.gazetteer;
  const gazetteer = buildGazetteer(db);
  cache.set(db, { stamp, gazetteer });
  return gazetteer;
}

/**
 * Graph neighbours of canonical entities: entities sharing a source with them, or one claim away. Members of a
 * merged identity count as the canonical. Bounded per entity; used only to separate ambiguous surfaces.
 */
export function registryNeighbours(db: Database, ids: number[], limit = 400): Map<number, Set<number>> {
  const result = new Map<number, Set<number>>();
  const canonicalCache = new Map<number, number>();
  const parentOf = db.query<{ canonical_id: number | null }, [number]>('SELECT canonical_id FROM entities WHERE id=?');
  const canonical = (id: number) => {
    const cached = canonicalCache.get(id);
    if (cached !== undefined) return cached;
    let current = id;
    for (let depth = 0; depth < 32; depth++) {
      const next = parentOf.get(current)?.canonical_id;
      if (next == null) break;
      current = next;
    }
    canonicalCache.set(id, current);
    return current;
  };
  const neighbours = db.query<{ id: number }, [number, number]>(`WITH RECURSIVE m(id) AS (SELECT ? UNION SELECT e.id FROM entities e JOIN m ON e.canonical_id=m.id)
    SELECT id FROM (
      SELECT b.entity_id AS id FROM source_entities a JOIN source_entities b ON b.source_id=a.source_id WHERE a.entity_id IN (SELECT id FROM m)
      UNION SELECT object_id FROM graph_claims WHERE subject_id IN (SELECT id FROM m) AND object_id IS NOT NULL AND status IN ('accepted','proposed')
      UNION SELECT subject_id FROM graph_claims WHERE object_id IN (SELECT id FROM m) AND status IN ('accepted','proposed')
    ) LIMIT ?`);
  for (const id of ids) result.set(id, new Set(neighbours.all(id, limit).map(row => canonical(row.id))));
  return result;
}
