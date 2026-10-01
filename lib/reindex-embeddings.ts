import type { Database } from "bun:sqlite";
import { getEmbeddings } from "./ai/embeddings";
import type { EmbedderOptions } from "./ai/types";
import { modelCoordinator } from "./ai/scheduler";
import { resolveModelResource, resolveEmbeddingEndpoint } from "./ai/config";
import { getIndexDimension, vectorBuffer } from "./embedding-index";
import {
  writeEmbeddingProfile,
  embeddingProfile,
  readEmbeddingProfile,
  type EmbeddingProfile,
} from "./embedding-profile";

/** Stage a complete new index, then replace the old vectors in one transaction. */
export async function reindexEmbeddings(
  database: Database,
  options: EmbedderOptions = {},
  batchSize = 32,
): Promise<number> {
  if (!Number.isInteger(batchSize) || batchSize < 1)
    throw new Error("Reindex batch size must be a positive integer");
  const chunks = () =>
    database
      .query<{ id: number; source_id: string; text_content: string }, []>(
        "SELECT id, source_id, text_content FROM chunks ORDER BY id",
      )
      .all();
  const snapshot = chunks();
  const dimension = getIndexDimension(database);
  readEmbeddingProfile(database);
  const resolved = { ...options, padToDimensions: dimension };
  const endpoint = resolveEmbeddingEndpoint(resolved);
  const resource = resolveModelResource(endpoint, options.resource);
  return modelCoordinator.exclusive(resource, () =>
    modelCoordinator.phase("embedding", async () => {
      database.run(
        "CREATE TEMP TABLE reindex_vectors (id INTEGER PRIMARY KEY, embedding BLOB NOT NULL)",
      );
      let profile: EmbeddingProfile | undefined;
      try {
        const insert = database.query(
          "INSERT INTO reindex_vectors VALUES (?, ?)",
        );
        for (let start = 0; start < snapshot.length; start += batchSize) {
          const batch = snapshot.slice(start, start + batchSize);
          const vectors = await getEmbeddings(
            batch.map((chunk) => chunk.text_content),
            resolved,
          );
          for (let i = 0; i < vectors.length; i++) {
            const current = embeddingProfile(vectors[i])!;
            if (
              profile &&
              JSON.stringify(profile) !== JSON.stringify(current)
            ) {
              throw new Error(
                "Embedding configuration changed during reindexing; old index retained",
              );
            }
            profile = current;
            insert.run(batch[i].id, vectorBuffer(vectors[i], dimension));
          }
        }
        database.transaction(() => {
          if (JSON.stringify(snapshot) !== JSON.stringify(chunks())) {
            throw new Error(
              "Chunks changed during reindexing; old index retained. Retry when ingestion is idle.",
            );
          }
          database.run("DELETE FROM vector_index");
          database.run(
            "INSERT INTO vector_index (rowid, embedding) SELECT id, embedding FROM reindex_vectors",
          );
          if (profile) writeEmbeddingProfile(database, profile);
          else database.run("DELETE FROM embedding_profile");
        })();
        return snapshot.length;
      } finally {
        database.run("DROP TABLE reindex_vectors");
      }
    }),
  );
}
