import type { Database } from "bun:sqlite";

export function validateVector(
  vector: number[] | Float32Array,
  dimension?: number,
): void {
  if (
    !(Array.isArray(vector) || vector instanceof Float32Array) ||
    !vector.length ||
    (dimension !== undefined && vector.length !== dimension) ||
    !vector.every(
      (value) =>
        typeof value === "number" &&
        Number.isFinite(value) &&
        Number.isFinite(Math.fround(value)),
    )
  ) {
    throw new Error(
      `Invalid embedding vector${dimension ? `: expected ${dimension} finite dimensions` : ""}`,
    );
  }
}

/** Zero padding is an explicit storage policy. Truncation changes vector meaning. */
export function normalizeVectorDimensions(
  vector: number[],
  targetDim = 4096,
): number[] {
  validateVector(vector);
  if (!Number.isInteger(targetDim) || targetDim <= 0)
    throw new Error("Embedding storage dimensions must be a positive integer");
  if (vector.length > targetDim)
    throw new Error(
      `Embedding has ${vector.length} dimensions; storage supports ${targetDim}. Reindex with a compatible profile.`,
    );
  if (vector.length === targetDim) return vector;
  return [...vector, ...new Array(targetDim - vector.length).fill(0)];
}

export function getIndexDimension(database: Database): number {
  const row = database
    .query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE name = 'vector_index'",
    )
    .get();
  const match = row?.sql?.match(/float\[(\d+)\]/i);
  if (!match) throw new Error("Cannot determine vector_index dimensions");
  return Number(match[1]);
}

export function vectorBuffer(
  vector: number[] | Float32Array,
  dimension: number,
): Uint8Array {
  validateVector(vector, dimension);
  const floats = new Float32Array(vector);
  return new Uint8Array(floats.buffer);
}
