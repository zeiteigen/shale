import type { Database } from "bun:sqlite";
import { randomUUIDv7 } from "bun";
import { createHash } from "node:crypto";
import type { GraphIngestor } from "../graph";
import { ensureStorySchema } from "../../lib/graph/story-schema";
import { canonicalOf, indexEntity } from "./registry";

export type MemberRole = "trigger" | "progress" | "outcome" | "context";
export interface EpisodeMember {
  claimId: string;
  sourceId: string;
  title: string;
  origin: string;
  uri: string;
  at: number | null;
  role: MemberRole;
  step: string;
  status: string;
  confidence: number | null;
  summary: string;
}
export interface EpisodeSummary {
  id: number;
  title: string;
  kind: string;
  status: string;
  summary: string;
  startedAt: number | null;
  lastActivityAt: number | null;
  members: number;
  origins: string[];
}

const short = (...parts: unknown[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
const ACTIVE = "('accepted','proposed')";

/** Every entity id merged into an episode, for membership lookups across merges. */
function group(db: Database, id: number): number[] {
  return db
    .query<{ id: number }, [number]>(
      `WITH RECURSIVE m(id) AS (SELECT ? UNION SELECT e.id FROM entities e JOIN m ON e.canonical_id=m.id)
    SELECT id FROM m`,
    )
    .all(canonicalOf(db, id))
    .map((row) => row.id);
}

export class EpisodeStore {
  /** Readers may run on a sealed, scoped connection, so only writes set up the schema. */
  constructor(
    private db: Database,
    private graph: GraphIngestor,
  ) {}

  /** The entity that stands for a source in the graph (its connector record), created when a source has none. */
  recordEntity(sourceId: string): number {
    const existing = this.db
      .query<
        { entity_id: number },
        [string]
      >("SELECT entity_id FROM graph_aliases WHERE scope='source-id' AND alias=? ORDER BY entity_id LIMIT 1")
      .get(sourceId);
    if (existing) return canonicalOf(this.db, existing.entity_id);
    const source = this.db
      .query<
        { title: string },
        [string]
      >("SELECT title FROM sources WHERE id=?")
      .get(sourceId);
    if (!source) throw new Error(`Unknown source ${sourceId}`);
    const entity = this.graph.entities.create({
      stableId: `source-record:${sourceId}`,
      name: source.title || sourceId,
      type: "Source",
      namespace: "episodes",
    });
    this.graph.entities.addAlias(entity.id, sourceId, "source-id");
    this.db
      .query(
        "INSERT OR IGNORE INTO source_entities(source_id,entity_id) VALUES(?,?)",
      )
      .run(sourceId, entity.id);
    return entity.id;
  }

  create(input: {
    title: string;
    kind: string;
    at: number | null;
    aliases?: string[];
  }): number {
    ensureStorySchema(this.db);
    return this.db.transaction(() => {
      const entity = this.graph.entities.create({
        stableId: `episode:${randomUUIDv7()}`,
        name: input.title.slice(0, 120),
        type: "Episode",
        namespace: "episodes",
        aliases: (input.aliases ?? []).map((name) => ({
          name,
          scope: "search",
        })),
      });
      this.db
        .query(
          `INSERT INTO graph_episodes(entity_id,kind,status,summary,started_at,last_activity_at,updated_at)
        VALUES(?,?,'active','',?,?,?)`,
        )
        .run(entity.id, input.kind, input.at, input.at, Date.now());
      return entity.id;
    })();
  }

  isMember(episodeId: number, sourceId: string): boolean {
    const ids = group(this.db, episodeId);
    return Boolean(
      this.db
        .query(
          `SELECT 1 FROM graph_claims WHERE predicate='PART_OF_EPISODE' AND status IN ${ACTIVE}
      AND object_id IN (${ids.map(() => "?").join(",")}) AND json_extract(qualifiers,'$.sourceId')=?`,
        )
        .get(...ids, sourceId),
    );
  }

  /** Add a source to an episode. Idempotent per (episode, source). */
  attach(
    episodeId: number,
    sourceId: string,
    input: {
      role: MemberRole;
      step: string;
      at: number | null;
      confidence: number;
      status: "accepted" | "proposed";
      basis: string;
      method?: string;
      model?: string;
    },
  ) {
    const episode = canonicalOf(this.db, episodeId);
    this.db.transaction(() => {
      if (this.isMember(episode, sourceId)) return;
      const member = this.recordEntity(sourceId);
      // A detached membership stays retracted for history; re-attaching records a fresh claim.
      const previous = this.db
        .query<
          { n: number },
          [string]
        >("SELECT count(*) AS n FROM graph_claims WHERE id GLOB ?")
        .get(`episode-member:${short(episode, sourceId)}*`)!.n;
      const claimId = `episode-member:${short(episode, sourceId)}${previous ? `:${previous}` : ""}`;
      this.graph.claims.add({
        id: claimId,
        namespace: "episodes",
        subject: member,
        predicate: "PART_OF_EPISODE",
        object: episode,
        status: input.status,
        confidence: input.confidence,
        method: input.method ?? "episode-assignment",
        model: input.model,
        validFrom: input.at ?? undefined,
        qualifiers: {
          sourceId,
          role: input.role,
          step: input.step.slice(0, 200),
          basis: input.basis.slice(0, 200),
        },
      });
      // The episode is grounded in its members: access visibility and tiers follow them.
      this.db
        .query(
          "INSERT OR IGNORE INTO source_entities(source_id,entity_id) VALUES(?,?)",
        )
        .run(sourceId, episode);
      this.db
        .query(
          "INSERT OR IGNORE INTO graph_episode_provenance(entity_id,source_id) VALUES(?,?)",
        )
        .run(episode, sourceId);
      if (input.at !== null)
        this.db
          .query(
            `UPDATE graph_episodes SET started_at=min(coalesce(started_at,?),?),
        last_activity_at=max(coalesce(last_activity_at,?),?),updated_at=?,status=CASE WHEN status='dormant' THEN 'active' ELSE status END
        WHERE entity_id=?`,
          )
          .run(input.at, input.at, input.at, input.at, Date.now(), episode);
      else
        this.db
          .query("UPDATE graph_episodes SET updated_at=? WHERE entity_id=?")
          .run(Date.now(), episode);
    })();
  }

  /** Name an entity the episode involves (accepted: it was shared by members or chosen by the digest). */
  involve(episodeId: number, entityId: number, weight: number) {
    const episode = canonicalOf(this.db, episodeId),
      entity = canonicalOf(this.db, entityId);
    if (episode === entity) return;
    const claimId = `episode-involves:${short(episode, entity)}`;
    if (this.db.query("SELECT 1 FROM graph_claims WHERE id=?").get(claimId))
      return;
    this.graph.claims.add({
      id: claimId,
      namespace: "episodes",
      subject: episode,
      predicate: "INVOLVES",
      object: entity,
      status: "accepted",
      method: "episode-assignment",
      strength: Math.round(weight * 100) / 100,
    });
  }

  /** Remove a source from an episode; the membership claim is retracted, not deleted. */
  detach(episodeId: number, sourceId: string, actor: string, reason: string) {
    const ids = group(this.db, episodeId);
    this.db.transaction(() => {
      const claims = this.db
        .query<{ id: string }, (number | string)[]>(
          `SELECT id FROM graph_claims WHERE predicate='PART_OF_EPISODE'
        AND status IN ${ACTIVE} AND object_id IN (${ids.map(() => "?").join(",")}) AND json_extract(qualifiers,'$.sourceId')=?`,
        )
        .all(...ids, sourceId);
      for (const claim of claims)
        this.graph.lifecycle.review(claim.id, "retracted", actor, reason);
      // Narrative provenance survives detachment until consolidation replaces the narrative.
      // Otherwise a formerly hidden member could become readable in the old title/summary.
      this.db
        .query(
          "UPDATE graph_source_digests SET episode_state='none' WHERE source_id=?",
        )
        .run(sourceId);
      this.db
        .query("UPDATE graph_episodes SET updated_at=? WHERE entity_id=?")
        .run(Date.now(), canonicalOf(this.db, episodeId));
    })();
  }

  /** Fold identities without copying membership or metadata; unmerge separates the groups again. */
  merge(from: number, into: number, reason: string): string {
    return this.db
      .transaction(() => {
        const loser = canonicalOf(this.db, from),
          winner = canonicalOf(this.db, into);
        if (loser === winner) throw new Error("Episodes are already merged");
        const change = this.graph.entities.merge(loser, winner, reason);
        this.db
          .query("UPDATE graph_episodes SET updated_at=? WHERE entity_id=?")
          .run(Date.now(), winner);
        indexEntity(this.db, loser);
        indexEntity(this.db, winner);
        return change;
      })
      .immediate();
  }

  private dates(episodeId: number) {
    const ids = group(this.db, episodeId);
    return this.db
      .query<
        { startedAt: number | null; lastActivityAt: number | null },
        number[]
      >(
        `SELECT min(started_at) AS startedAt,max(last_activity_at) AS lastActivityAt FROM graph_episodes
        WHERE entity_id IN (${ids.map(() => "?").join(",")})`,
      )
      .get(...ids)!;
  }

  members(episodeId: number): EpisodeMember[] {
    const ids = group(this.db, episodeId);
    return this.db
      .query<
        {
          id: string;
          qualifiers: string;
          valid_from: number | null;
          status: string;
          confidence: number | null;
          title: string | null;
          origin: string | null;
          uri: string | null;
          summary: string | null;
        },
        number[]
      >(
        `SELECT c.id,c.qualifiers,c.valid_from,c.status,
      c.confidence,s.title,s.origin,s.uri,d.summary FROM graph_claims c
      LEFT JOIN sources s ON s.id=json_extract(c.qualifiers,'$.sourceId')
      LEFT JOIN graph_source_digests d ON d.source_id=json_extract(c.qualifiers,'$.sourceId')
      WHERE c.predicate='PART_OF_EPISODE' AND c.status IN ${ACTIVE} AND c.object_id IN (${ids.map(() => "?").join(",")})
      AND (s.id IS NOT NULL OR c.subject_id IN (SELECT id FROM entities))
      ORDER BY coalesce(c.valid_from,0),c.id`,
      )
      .all(...ids)
      .flatMap((row) => {
        const qualifiers = JSON.parse(row.qualifiers) as {
          sourceId?: string;
          role?: MemberRole;
          step?: string;
        };
        if (!qualifiers.sourceId || row.title === null) return [];
        const steps = JSON.parse(
          this.db
            .query<
              { steps: string },
              [number]
            >("SELECT steps FROM graph_episodes WHERE entity_id=?")
            .get(canonicalOf(this.db, episodeId))?.steps ?? "{}",
        ) as Record<string, string>;
        return [
          {
            claimId: row.id,
            sourceId: qualifiers.sourceId,
            title: row.title,
            origin: row.origin ?? "",
            uri: row.uri ?? "",
            at: row.valid_from,
            role: qualifiers.role ?? "progress",
            step: steps[qualifiers.sourceId] ?? qualifiers.step ?? "",
            status: row.status,
            confidence: row.confidence,
            summary: row.summary ?? "",
          },
        ];
      });
  }

  involved(episodeId: number, limit = 20) {
    const ids = group(this.db, episodeId);
    return this.db
      .query<
        { id: number; name: string; type: string; strength: number },
        number[]
      >(
        `SELECT e.id,coalesce(e.display_name,e.name) AS name,
      e.type,max(c.strength) AS strength FROM graph_claims c JOIN entities e ON e.id=c.object_id
      WHERE c.predicate='INVOLVES' AND c.status IN ${ACTIVE} AND c.subject_id IN (${ids.map(() => "?").join(",")})
      GROUP BY e.id ORDER BY strength DESC LIMIT ?`,
      )
      .all(...ids, limit)
      .map((row) => ({ ...row, id: canonicalOf(this.db, row.id) }));
  }

  get(episodeId: number) {
    const id = canonicalOf(this.db, episodeId);
    const row = this.db
      .query<
        {
          name: string;
          kind: string;
          status: string;
          summary: string;
          started_at: number | null;
          last_activity_at: number | null;
        },
        [number]
      >(
        `SELECT coalesce(e.display_name,e.name) AS name,g.kind,g.status,g.summary,g.started_at,g.last_activity_at
      FROM graph_episodes g JOIN entities e ON e.id=g.entity_id WHERE g.entity_id=?`,
      )
      .get(id);
    if (!row) return null;
    return {
      id,
      title: row.name,
      kind: row.kind,
      status: row.status,
      summary: row.summary,
      ...this.dates(id),
      members: this.members(id),
      involves: this.involved(id),
    };
  }

  /** Episodes, most recently active first; optionally those matching text or involving an entity. */
  list(
    options: {
      status?: string;
      query?: string;
      entityId?: number;
      limit?: number;
      offset?: number;
    } = {},
  ): EpisodeSummary[] {
    const where = ["e.canonical_id IS NULL"];
    const params: (string | number)[] = [];
    if (options.status) {
      where.push("g.status=?");
      params.push(options.status);
    }
    if (options.entityId !== undefined) {
      const ids = group(this.db, options.entityId);
      where.push(`EXISTS(SELECT 1 FROM graph_claims c WHERE c.subject_id IN
        (WITH RECURSIVE m(id) AS (SELECT g.entity_id UNION SELECT e.id FROM entities e JOIN m ON e.canonical_id=m.id) SELECT id FROM m)
        AND c.predicate='INVOLVES' AND c.status IN ${ACTIVE}
        AND c.object_id IN (${ids.map(() => "?").join(",")}))`);
      params.push(...ids);
    }
    if (options.query?.trim()) {
      const terms = options.query.match(/[\p{L}\p{N}]{2,}/gu) ?? [];
      if (!terms.length) return [];
      where.push(
        `g.entity_id IN (SELECT rowid FROM entity_registry_fts WHERE entity_registry_fts MATCH ?)`,
      );
      params.push(terms.map((term) => `"${term}"`).join(" OR "));
    }
    const rows = this.db
      .query<
        {
          id: number;
          name: string;
          kind: string;
          status: string;
          summary: string;
          started_at: number | null;
          last_activity_at: number | null;
        },
        (string | number)[]
      >(
        `SELECT g.entity_id AS id,coalesce(e.display_name,e.name) AS name,g.kind,g.status,
        g.summary,g.started_at,g.last_activity_at FROM graph_episodes g JOIN entities e ON e.id=g.entity_id
      WHERE ${where.join(" AND ")} ORDER BY coalesce((SELECT max(last_activity_at) FROM graph_episodes WHERE entity_id IN
        (WITH RECURSIVE m(id) AS (SELECT g.entity_id UNION SELECT e.id FROM entities e JOIN m ON e.canonical_id=m.id) SELECT id FROM m)),0) DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, options.limit ?? 20, options.offset ?? 0);
    return rows.map((row) => {
      const members = this.members(row.id);
      return {
        id: row.id,
        title: row.name,
        kind: row.kind,
        status: row.status,
        summary: row.summary,
        ...this.dates(row.id),
        members: members.length,
        origins: [...new Set(members.map((member) => member.origin))],
      };
    });
  }

  /** Episodes a source belongs to. */
  ofSource(sourceId: string): number[] {
    // Through the source's record entities, so the subject index is used rather than a scan of every claim.
    return [
      ...new Set(
        this.db
          .query<{ object_id: number }, [string, string]>(
            `SELECT object_id FROM graph_claims WHERE predicate='PART_OF_EPISODE'
      AND status IN ${ACTIVE} AND subject_id IN (SELECT entity_id FROM graph_aliases WHERE scope='source-id' AND alias=?)
      AND json_extract(qualifiers,'$.sourceId')=?`,
          )
          .all(sourceId, sourceId)
          .map((row) => canonicalOf(this.db, row.object_id)),
      ),
    ];
  }
}
