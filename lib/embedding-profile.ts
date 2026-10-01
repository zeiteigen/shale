import type { Database } from "bun:sqlite";
import { getIndexDimension } from "./embedding-index";

export interface EmbeddingProfile {
  model: string;
  endpoint: string;
  dimensions: number;
  storageDimensions: number;
  instruction: string | null;
}

const profiles = new WeakMap<number[] | Float32Array, EmbeddingProfile>();
export function tagEmbedding(
  vector: number[],
  profile: EmbeddingProfile,
): number[] {
  profiles.set(vector, profile);
  return vector;
}
export const embeddingProfile = (
  vector: number[] | Float32Array,
): EmbeddingProfile | undefined => profiles.get(vector);

function ensureTable(database: Database): void {
  database.run(
    "CREATE TABLE IF NOT EXISTS embedding_profile (id INTEGER PRIMARY KEY CHECK (id = 1), profile TEXT NOT NULL)",
  );
}

export function readEmbeddingProfile(
  database: Database,
): EmbeddingProfile | null {
  ensureTable(database);
  const row = database
    .query<{ profile: string }, []>(
      "SELECT profile FROM embedding_profile WHERE id = 1",
    )
    .get();
  return row ? JSON.parse(row.profile) : null;
}

function equal(a: EmbeddingProfile, b: EmbeddingProfile): boolean {
  return (
    a.model === b.model &&
    a.endpoint === b.endpoint &&
    a.dimensions === b.dimensions &&
    a.storageDimensions === b.storageDimensions &&
    a.instruction === b.instruction
  );
}

/** Explicit migration for an existing index whose provenance has been independently verified. */
export function writeEmbeddingProfile(
  database: Database,
  profile: EmbeddingProfile,
): void {
  if (
    !profile.model ||
    !profile.endpoint ||
    !Number.isInteger(profile.dimensions) ||
    profile.dimensions < 1 ||
    profile.dimensions > profile.storageDimensions ||
    profile.storageDimensions !== getIndexDimension(database)
  ) {
    throw new Error(
      "Embedding profile is incompatible with the index dimensions",
    );
  }
  ensureTable(database);
  database
    .query(
      "INSERT INTO embedding_profile (id, profile) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET profile = excluded.profile",
    )
    .run(JSON.stringify(profile));
}

export function adoptEmbeddingProfile(
  database: Database,
  profile: EmbeddingProfile,
): void {
  const recorded = readEmbeddingProfile(database);
  if (recorded && !equal(recorded, profile))
    throw new Error(
      "A tracked embedding profile can only change through reindexing",
    );
  writeEmbeddingProfile(database, profile);
}

export function assertEmbeddingProfile(
  database: Database,
  profile: EmbeddingProfile,
  initialize = false,
): void {
  const recorded = readEmbeddingProfile(database);
  if (recorded && !equal(recorded, profile)) {
    throw new Error(
      "Embedding profile differs from vector_index. Reindex before changing models, dimensions, endpoint, or instruction.",
    );
  }
  if (!recorded) {
    const count = database
      .query<{ count: number }, []>(
        "SELECT count(*) AS count FROM vector_index",
      )
      .get()!.count;
    if (count)
      throw new Error(
        "Existing vector_index has unknown embedding provenance. Reindex or explicitly adopt its verified embedding profile.",
      );
    if (initialize) adoptEmbeddingProfile(database, profile);
  }
}
