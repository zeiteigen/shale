import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import type { GraphIngestor } from '../graph';
import { ensureStorySchema } from '../../lib/graph/story-schema';
import { AFFILIATION_KEY_KINDS, identityKeys, type IdentityKey } from '../../lib/graph/identity-keys';
import { sameFamily, typeFamily } from '../../lib/graph/ontology';
import { canonicalOf, connectorKeys, describe, entitiesWithKeys, indexEntity, keysOf, writeKeys } from './registry';

/**
 * Cross-source identity. Every decision is recorded: merges in graph_identity_changes (reversible with
 * unmerge), links as claims with method `resolver`, uncertain pairs in graph_resolution_queue.
 *
 * Policy: a strong identity key for the entity's family (an account, a repository, a URL), or the model's
 * registry match corroborated by a name key, merges automatically. Name or acronym collisions alone, and
 * model matches without key support, wait for model adjudication; people are never merged by name alone.
 */
export const SELF_STABLE_ID = 'self';
export type MentionDecision = { canonicalId: number; outcome: 'merged' | 'queued' | 'new' | 'existing'; basis: string[] };
export interface MentionInput {
  entityId: number; type: string; names: string[]; match?: number | null; urls?: string[]; emails?: string[];
}

/** Whether a key kind can identify an entity of a family (rather than merely point at something related). */
export function identityBearing(family: string, key: IdentityKey): boolean {
  switch (key.kind) {
    case 'external': return true;
    case 'url': return ['WebPage', 'Artifact', 'Product', 'Project'].includes(family);
    case 'github': case 'gitlab':
      return key.value.includes('/') ? ['Artifact', 'Project', 'Product'].includes(family) : ['Person', 'Organization'].includes(family);
    case 'linkedin': return key.value.startsWith('in/') ? family === 'Person' : family === 'Organization';
    case 'email': case 'discord-user': return family === 'Person';
    case 'discord-guild': return family === 'Community';
    default: return false;
  }
}

const WEAK = new Set(['name', 'acronym']);
const id = (...parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);

export class IdentityResolver {
  constructor(private db: Database, private graph: GraphIngestor) { ensureStorySchema(db); }

  private type(entityId: number) {
    return this.db.query<{ type: string }, [number]>('SELECT type FROM entities WHERE id=?').get(entityId)?.type ?? '';
  }

  private merge(from: number, into: number, reason: string): boolean {
    const source = canonicalOf(this.db, from), target = canonicalOf(this.db, into);
    if (source === target) return false;
    if (!sameFamily(this.type(source), this.type(target))) return false;
    // Keep the self identity and older canonicals as the surviving record.
    const [loser, winner] = this.db.query("SELECT 1 FROM entities WHERE id=? AND stable_id=?").get(source, SELF_STABLE_ID)
      ? [target, source] : [source, target];
    this.graph.entities.merge(loser, winner, reason);
    indexEntity(this.db, loser);
    indexEntity(this.db, winner);
    return true;
  }

  private link(subject: number, predicate: string, object: number, confidence: number, status: 'accepted' | 'proposed', basis: string) {
    const claimId = `resolver:${id(predicate, subject, object)}`;
    if (this.db.query('SELECT 1 FROM graph_claims WHERE id=?').get(claimId)) return;
    this.graph.claims.add({ id: claimId, namespace: 'knowledge', subject, predicate, object, confidence, status,
      method: 'resolver', qualifiers: { basis } });
  }

  private queue(mention: number, candidate: number, basis: string) {
    this.db.query(`INSERT INTO graph_resolution_queue(mention_id,candidate_id,basis,created_at) VALUES(?,?,?,?)
      ON CONFLICT(mention_id,candidate_id) DO NOTHING`).run(mention, candidate, basis, Date.now());
  }

  /**
   * Links that keys justify between different kinds of things: a page about a repository or account,
   * a Discord server that is an organization's community.
   */
  crossLink(entityId: number) {
    const self = canonicalOf(this.db, entityId);
    const family = typeFamily(this.type(self));
    // Domains are shared by whole sites and mail providers; they never establish a link on their own.
    const keys = keysOf(this.db, self).filter(key => !AFFILIATION_KEY_KINDS.has(key.kind));
    for (const [other, matched] of entitiesWithKeys(this.db, keys, self)) {
      const otherFamily = typeFamily(this.type(other));
      if (otherFamily === family) continue;
      const pointsAtOther = matched.find(key => identityBearing(otherFamily, key));
      const pointsAtSelf = matched.find(key => identityBearing(family, key));
      if (family === 'WebPage' && pointsAtOther)
        this.link(self, 'REFERS_TO', other, 1, 'accepted', `${pointsAtOther.kind}:${pointsAtOther.value}`);
      else if (otherFamily === 'WebPage' && pointsAtSelf)
        this.link(other, 'REFERS_TO', self, 1, 'accepted', `${pointsAtSelf.kind}:${pointsAtSelf.value}`);
      else if (new Set([family, otherFamily]).has('Community') && new Set([family, otherFamily]).has('Organization')) {
        const [community, organization] = family === 'Community' ? [self, other] : [other, self];
        const byName = matched.some(key => key.kind === 'name');
        const weak = matched.find(key => WEAK.has(key.kind));
        if (weak) this.link(community, 'COMMUNITY_OF', organization, byName ? 0.9 : 0.7, byName ? 'accepted' : 'proposed',
          `${weak.kind}:${weak.value}`);
      }
    }
  }

  /** Resolve a newly extracted mention against the registry. Idempotent for already-merged mentions. */
  resolveMention(input: MentionInput): MentionDecision {
    return this.db.transaction((): MentionDecision => {
      const mention = input.entityId;
      if (canonicalOf(this.db, mention) !== mention)
        return { canonicalId: canonicalOf(this.db, mention), outcome: 'existing', basis: [] };
      const family = typeFamily(input.type);
      const keys = identityKeys({ names: input.names, urls: input.urls, emails: input.emails });
      writeKeys(this.db, mention, keys);
      const hits = [...entitiesWithKeys(this.db, keys, mention)].filter(([other]) => sameFamily(this.type(other), input.type));
      const strong = hits.find(([, matched]) => matched.some(key => identityBearing(family, key)));
      const match = input.match ? canonicalOf(this.db, input.match) : null;
      const usableMatch = match !== null && match !== mention && sameFamily(this.type(match), input.type) ? match : null;
      let decision: MentionDecision = { canonicalId: mention, outcome: 'new', basis: [] };
      if (strong) {
        const basis = strong[1].filter(key => identityBearing(family, key)).map(key => `${key.kind}:${key.value}`);
        if (this.merge(mention, strong[0], `Shared identity key ${basis.join(', ')}`))
          decision = { canonicalId: canonicalOf(this.db, mention), outcome: 'merged', basis };
      } else if (usableMatch !== null && hits.some(([other]) => other === usableMatch) && family !== 'Person') {
        const basis = ['model-match', ...hits.find(([other]) => other === usableMatch)![1].map(key => `${key.kind}:${key.value}`)];
        if (this.merge(mention, usableMatch, `Model registry match corroborated by ${basis.slice(1).join(', ')}`))
          decision = { canonicalId: canonicalOf(this.db, mention), outcome: 'merged', basis };
      } else {
        const candidates = new Map<number, string>();
        if (usableMatch !== null) candidates.set(usableMatch, 'model-match');
        for (const [other, matched] of hits) if (!candidates.has(other))
          candidates.set(other, matched.map(key => `${key.kind}:${key.value}`).join(','));
        for (const [candidate, basis] of [...candidates].slice(0, 3)) this.queue(mention, candidate, basis);
        if (candidates.size) decision = { canonicalId: mention, outcome: 'queued', basis: [...candidates.values()] };
      }
      indexEntity(this.db, decision.canonicalId);
      this.crossLink(decision.canonicalId);
      return decision;
    })();
  }

  /** Give connector-owned people, servers, and pages their identity keys, then merge or link by key. */
  keyConnectorEntities(limit = 2000): { keyed: number; merged: number } {
    const rows = this.db.query<{ id: number; type: string }, [number]>(`SELECT e.id,e.type FROM entities e
      WHERE e.type IN ('Person','Bot','Server','WebPage') AND e.canonical_id IS NULL
      AND EXISTS(SELECT 1 FROM graph_aliases a WHERE a.entity_id=e.id AND a.scope='connector-key')
      AND NOT EXISTS(SELECT 1 FROM graph_aliases a WHERE a.entity_id=e.id AND a.scope GLOB 'key:*')
      AND NOT EXISTS(SELECT 1 FROM graph_entity_retirements r WHERE r.entity_id=e.id) ORDER BY e.id LIMIT ?`).all(limit);
    let merged = 0;
    for (const row of rows) this.db.transaction(() => {
      const keys = connectorKeys(this.db, row.id);
      writeKeys(this.db, row.id, keys.length ? keys : [{ kind: 'none', value: '-' }]);
      const family = typeFamily(row.type);
      for (const [other, matched] of entitiesWithKeys(this.db, keys, row.id)) {
        if (!sameFamily(this.type(other), row.type)) continue;
        const strong = matched.filter(key => identityBearing(family, key));
        if (strong.length && this.merge(row.id, other, `Shared identity key ${strong.map(key => `${key.kind}:${key.value}`).join(', ')}`)) {
          merged++;
          break;
        }
      }
      indexEntity(this.db, canonicalOf(this.db, row.id));
      this.crossLink(row.id);
    })();
    return { keyed: rows.length, merged };
  }

  /**
   * The person whose data this is. Accounts listed here (and connected accounts) merge into one
   * Person with stable id `self`, so "you" is a single node across Discord, email, and GitHub.
   */
  ensureSelf(config: { names?: string[]; emails?: string[]; handles?: string[]; discordIds?: string[] }): number {
    return this.db.transaction(() => {
      const names = (config.names ?? []).filter(name => name.trim());
      const existing = this.db.query<{ id: number }, [string]>('SELECT id FROM entities WHERE stable_id=?').get(SELF_STABLE_ID);
      const self = existing?.id ?? this.graph.entities.create({ stableId: SELF_STABLE_ID, name: names[0] ?? 'Me', type: 'Person',
        namespace: 'knowledge', aliases: [{ name: 'me', scope: 'search' }, { name: 'self', scope: 'search' }] }).id;
      for (const name of names) this.graph.entities.addAlias(self, name);
      const keys: IdentityKey[] = [
        ...identityKeys({ names: [], emails: config.emails ?? [] }).filter(key => key.kind === 'email'),
        ...(config.discordIds ?? []).map(value => ({ kind: 'discord-user', value })),
        ...(config.handles ?? []).flatMap(handle => {
          const [kind, value] = handle.includes(':') ? handle.split(/:(.*)/s) as [string, string] : ['handle', handle];
          return value ? [{ kind: kind.toLowerCase(), value: value.toLowerCase() }] : [];
        }),
      ];
      writeKeys(this.db, self, keys);
      for (const [other, matched] of entitiesWithKeys(this.db, keys, self))
        if (sameFamily(this.type(other), 'Person') && matched.some(key => identityBearing('Person', key) || key.kind === 'handle'))
          this.merge(other, self, `Account of the user (${matched.map(key => `${key.kind}:${key.value}`).join(', ')})`);
      indexEntity(this.db, self);
      return self;
    })();
  }

  pending(limit: number) {
    // Least-tried first, so a batch the model cannot answer does not block everything queued after it.
    return this.db.query<{ mention_id: number; candidate_id: number; basis: string }, [number]>(`SELECT mention_id,candidate_id,basis
      FROM graph_resolution_queue WHERE state='pending' ORDER BY attempts,created_at LIMIT ?`).all(limit);
  }

  /** Count a model attempt on a pair; after three unanswered attempts it is left as unsure. */
  attempted(mention: number, candidate: number) {
    this.db.query(`UPDATE graph_resolution_queue SET attempts=attempts+1,
      state=CASE WHEN attempts+1>=3 AND state='pending' THEN 'unsure' ELSE state END,
      reason=CASE WHEN attempts+1>=3 AND state='pending' THEN 'no model verdict after three attempts' ELSE reason END
      WHERE mention_id=? AND candidate_id=?`).run(mention, candidate);
  }

  /** A compact description of an entity for an adjudication prompt. */
  profile(entityId: number) {
    const canonical = canonicalOf(this.db, entityId);
    const entity = this.graph.entities.get(canonical);
    const aliases = this.db.query<{ alias: string }, [number]>(`SELECT DISTINCT a.alias FROM graph_aliases a WHERE a.entity_id IN
      (WITH RECURSIVE m(id) AS (SELECT ?1 UNION SELECT e.id FROM entities e JOIN m ON e.canonical_id=m.id) SELECT id FROM m)
      AND (a.scope='' OR a.scope GLOB 'source:*') LIMIT 6`).all(canonical).map(row => row.alias).filter(alias => alias !== entity.name);
    const sources = this.db.query<{ title: string; at: number; origin: string }, [number]>(`SELECT DISTINCT s.title,s.updated_at AS at,s.origin
      FROM sources s JOIN source_entities se ON se.source_id=s.id WHERE se.entity_id IN
      (WITH RECURSIVE m(id) AS (SELECT ?1 UNION SELECT e.id FROM entities e JOIN m ON e.canonical_id=m.id) SELECT id FROM m)
      ORDER BY s.updated_at DESC LIMIT 3`).all(canonical);
    return { id: canonical, name: entity.name, type: entity.type, aliases, description: describe(this.db, canonical),
      seenIn: sources.map(source => `${source.origin}: ${source.title} (${new Date(source.at).toISOString().slice(0, 10)})`) };
  }

  /** Apply a model verdict on one queued pair. */
  decide(mention: number, candidate: number, verdict: 'same' | 'different' | 'unsure', confidence: number, reason: string) {
    this.db.transaction(() => {
      this.db.query(`UPDATE graph_resolution_queue SET state=?,confidence=?,decided_at=?,reason=? WHERE mention_id=? AND candidate_id=?`)
        .run(verdict, confidence, Date.now(), reason.slice(0, 500), mention, candidate);
      if (verdict !== 'same') return;
      if (confidence >= 0.85) this.merge(mention, candidate, `Model adjudication (${confidence.toFixed(2)}): ${reason}`.slice(0, 500));
      else if (confidence >= 0.6) this.link(canonicalOf(this.db, mention), 'COREFERS_TO', canonicalOf(this.db, candidate), confidence,
        'proposed', 'adjudication');
      // Other queued candidates of a merged mention are now moot.
      if (canonicalOf(this.db, mention) !== mention)
        this.db.query("UPDATE graph_resolution_queue SET state='different',decided_at=?,reason='superseded by merge' WHERE mention_id=? AND state='pending'")
          .run(Date.now(), mention);
    })();
  }

  /** Canonical groups sharing a weak key: duplicates that slipped past per-mention resolution. */
  sweepDuplicates(limit = 200): number {
    // Only groups with a pair not yet considered; considered pairs (including incompatible ones) are in the queue.
    const groups = this.db.query<{ ids: string }, [number]>(`WITH g AS (SELECT a.alias,min(a.entity_id) AS first,
        group_concat(DISTINCT a.entity_id) AS ids FROM graph_aliases a JOIN entities e ON e.id=a.entity_id AND e.canonical_id IS NULL
        WHERE a.scope IN ('key:name','key:acronym') AND NOT EXISTS(SELECT 1 FROM graph_entity_retirements r WHERE r.entity_id=e.id)
        GROUP BY a.alias HAVING count(DISTINCT a.entity_id) BETWEEN 2 AND 6)
      SELECT g.ids FROM g WHERE EXISTS(SELECT 1 FROM graph_aliases b JOIN entities e ON e.id=b.entity_id AND e.canonical_id IS NULL
        WHERE b.alias=g.alias AND b.scope IN ('key:name','key:acronym') AND b.entity_id!=g.first
        AND NOT EXISTS(SELECT 1 FROM graph_resolution_queue q WHERE q.mention_id=b.entity_id AND q.candidate_id=g.first))
      LIMIT ?`).all(limit);
    let queued = 0;
    for (const group of groups) {
      const ids = group.ids.split(',').map(Number).sort((a, b) => a - b);
      for (const later of ids.slice(1)) {
        const first = ids[0]!;
        if (this.db.query('SELECT 1 FROM graph_resolution_queue WHERE mention_id=? AND candidate_id=?').get(later, first)) continue;
        if (!sameFamily(this.type(first), this.type(later)) || typeFamily(this.type(first)) === 'WebPage') {
          // Record the pair as considered so the sweep does not keep returning this group.
          this.db.query(`INSERT OR IGNORE INTO graph_resolution_queue(mention_id,candidate_id,basis,created_at,state,reason)
            VALUES(?,?,'duplicate-sweep',?,'different','different kinds of thing')`).run(later, first, Date.now());
          continue;
        }
        this.queue(later, first, 'duplicate-sweep');
        queued++;
      }
    }
    return queued;
  }
}
