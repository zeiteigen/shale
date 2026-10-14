import type { ShaleSDK } from '@shale/sdk';
import { ensureStorySchema } from '../../lib/graph/story-schema';
import { acronymKeys, emailKeys, nameKeys, namePhrases, textReferences, urlKeys, type IdentityKey } from '../../lib/graph/identity-keys';
import { canonicalOf, isRegistryType, shortlist, describe } from '../../sdk/graph/registry';
import { SELF_STABLE_ID } from '../../sdk/graph/identity';
import type { DigestContext, ExtractionChunk } from './types';

export interface DigestSource { source_id: string; title: string; type: string; uri: string; origin: string; created_at: number; updated_at: number }

const day = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const MAX_REGISTRY = 15, MAX_EPISODES = 5, MAX_PARTICIPANTS = 12;

/** Who and where, from the connector's own graph: participants (marking the user) and venues. */
function connectorContext(sdk: ShaleSDK, sourceId: string) {
  // Connectors attach participants and venues to the source's event as ROLE:* claims, or directly to the source.
  const rows = sdk.database.query<{ id: number; type: string; name: string }, [string, string]>(`SELECT DISTINCT e.id,e.type,
      coalesce(e.display_name,e.name) AS name FROM (
      SELECT c.object_id AS id FROM source_entities se JOIN graph_claims c ON c.subject_id=se.entity_id
        WHERE se.source_id=? AND c.predicate IN ('ROLE:participant','ROLE:venue') AND c.object_id IS NOT NULL
      UNION SELECT se.entity_id FROM source_entities se WHERE se.source_id=?) x
    JOIN entities e ON e.id=x.id WHERE e.type IN ('Person','Bot','Conversation','Server') ORDER BY e.id LIMIT 60`).all(sourceId, sourceId);
  const conversations = rows.filter(row => row.type === 'Conversation').map(row => row.id);
  const servers = conversations.length ? sdk.database.query<{ name: string }, number[]>(`SELECT DISTINCT coalesce(s.display_name,s.name) AS name
    FROM graph_claims c JOIN entities s ON s.id=c.object_id WHERE c.predicate='PART_OF' AND s.type='Server'
    AND c.subject_id IN (${conversations.map(() => '?').join(',')})`).all(...conversations) : [];
  const self = sdk.database.query<{ id: number }, [string]>('SELECT id FROM entities WHERE stable_id=?').get(SELF_STABLE_ID)?.id;
  const people = rows.filter(row => row.type === 'Person' || row.type === 'Bot').slice(0, MAX_PARTICIPANTS)
    .map(row => ({ ...row, canonical: canonicalOf(sdk.database, row.id) }));
  return {
    people: people.map(person => ({ id: person.canonical, label: person.canonical === self ? `${person.name} (the user)` : person.name,
      self: person.canonical === self })),
    venues: [...rows.filter(row => row.type === 'Conversation').map(row => `channel ${row.name}`), ...servers.map(row => `server ${row.name}`)],
  };
}

/** Open episodes worth offering: lexical matches and recently active ones involving the shortlisted entities. */
function episodeShortlist(sdk: ShaleSDK, texts: string[], entityIds: number[], at: number) {
  const db = sdk.database;
  const found = new Map<number, { id: number; title: string; lastStep: string }>();
  const add = (id: number) => {
    if (found.size >= MAX_EPISODES || found.has(id)) return;
    const row = db.query<{ title: string; summary: string; status: string }, [number]>(`SELECT coalesce(e.display_name,e.name) AS title,
      g.summary,g.status FROM graph_episodes g JOIN entities e ON e.id=g.entity_id WHERE g.entity_id=? AND e.canonical_id IS NULL`).get(id);
    if (row && row.status !== 'closed') found.set(id, { id, title: row.title, lastStep: row.summary.split(/(?<=[.!?])\s/)[0]?.slice(0, 200) ?? '' });
  };
  if (entityIds.length) {
    const placeholders = entityIds.map(() => '?').join(',');
    for (const row of db.query<{ id: number }, number[]>(`SELECT g.entity_id AS id FROM graph_episodes g
      JOIN graph_claims c ON c.subject_id=g.entity_id AND c.predicate='INVOLVES' AND c.status IN ('accepted','proposed')
      WHERE c.object_id IN (${placeholders}) AND coalesce(g.last_activity_at,0)>=? GROUP BY g.entity_id
      ORDER BY count(*) DESC, g.last_activity_at DESC LIMIT 5`).all(...entityIds, at - 120 * 86_400_000)) add(row.id);
  }
  for (const entry of shortlist(db, { texts, types: ['Episode'], limit: MAX_EPISODES })) add(entry.id);
  return [...found.values()];
}

export function digestContext(sdk: ShaleSDK, source: DigestSource, chunks: ExtractionChunk[]): DigestContext {
  ensureStorySchema(sdk.database);
  const text = chunks.map(chunk => chunk.text_content).join('\n');
  const { urls, emails } = textReferences(text);
  const web = /^https?:\/\//.test(source.uri);
  const keys: IdentityKey[] = [...(web ? urlKeys(source.uri) : []), ...urls.slice(0, 20).flatMap(urlKeys),
    ...emails.slice(0, 10).flatMap(emailKeys),
    // "NH PC" in the text should find the registry's "NHPC" even though full-text tokens differ.
    ...namePhrases(`${source.title}\n${text}`).flatMap(phrase => [...nameKeys(phrase).map(value => ({ kind: 'name', value })),
      ...acronymKeys(phrase).map(value => ({ kind: 'acronym', value }))])];
  const { people, venues } = connectorContext(sdk, source.source_id);
  const self = sdk.database.query<{ id: number }, [string]>('SELECT id FROM entities WHERE stable_id=?').get(SELF_STABLE_ID)?.id;
  const registry = new Map<number, DigestContext['registry'][number]>();
  for (const person of people) {
    if (registry.size >= 6) break;
    const row = sdk.database.query<{ name: string; type: string }, [number]>(
      'SELECT coalesce(display_name,name) AS name,type FROM entities WHERE id=?').get(person.id);
    if (row && isRegistryType(row.type)) registry.set(person.id, { id: person.id, name: row.name, type: row.type, description: describe(sdk.database, person.id) });
  }
  for (const entry of shortlist(sdk.database, { keys, texts: [source.title, text], limit: MAX_REGISTRY, excludeTypes: ['Episode'],
    exclude: [...registry.keys()] })) {
    if (registry.size >= MAX_REGISTRY) break;
    if (entry.type !== 'Episode') registry.set(entry.id, { id: entry.id, name: entry.name, type: entry.type, description: entry.description });
  }
  const header = [
    `Origin: ${source.origin}; type: ${source.type}`,
    ...(web || /^email:|^discord:/.test(source.uri) ? [`Address: ${source.uri}`] : []),
    `Time: ${day(source.created_at)}${source.updated_at > source.created_at + 60_000 ? ` to ${day(source.updated_at)}` : ''} UTC`,
    ...(venues.length ? [`Where: ${venues.slice(0, 3).join('; ')}`] : []),
    ...(people.length ? [`Participants: ${people.map(person => person.label).join(', ')}`] : []),
  ];
  // When a chat's participants are known and the user is not among them, the user did not take part.
  // Email lists only senders, so a message addressed to the user does not show them; it is exempt.
  const userAbsent = source.origin !== 'email' && source.type === 'chat_session' && people.length > 0 && self !== undefined
    && !people.some(person => person.self);
  if (userAbsent) header.push('The user is not among the participants.');
  return { header, userAbsent, registry: [...registry.values()], episodes: episodeShortlist(sdk, [source.title, text], [...registry.keys()], source.updated_at),
    sourceUri: source.uri };
}
