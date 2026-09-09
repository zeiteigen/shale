import { Database } from "bun:sqlite";
import defaultDb from "../lib/db-init";
import type { IngestGraphOptions, IngestGraphResult } from "./types";

export class GraphIngestor {
  private readonly db: Database;
  readonly defaultNamespace: string;

  constructor(defaultNamespace: string = "default", database?: Database) {
    this.defaultNamespace = defaultNamespace;
    this.db = database ?? defaultDb;
  }

  /**
   * Ingests entities and edges within a namespace.
   * Handles internal ID resolution mapping entity names to database integer IDs.
   *
   * @param options Entity and edge definitions, plus optional namespace override
   */
  ingest(options: IngestGraphOptions): IngestGraphResult {
    const namespace = options.namespace || this.defaultNamespace;
    const { entities, edges } = options;

    const insertEntityStmt = this.db.query<
      { id: number; name: string },
      { $namespace: string; $name: string; $type: string }
    >(`
      INSERT INTO entities (namespace, name, type)
      VALUES ($namespace, $name, $type)
      ON CONFLICT(namespace, name) DO UPDATE SET type = excluded.type
      RETURNING id, name
    `);

    const findEntityByNameStmt = this.db.query<
      { id: number },
      { $namespace: string; $name: string }
    >(`
      SELECT id FROM entities
      WHERE namespace = $namespace AND name = $name
      LIMIT 1
    `);

    const insertEdgeStmt = this.db.query(`
      INSERT OR REPLACE INTO edges (source_entity_id, target_entity_id, relation, weight)
      VALUES ($source, $target, $relation, $weight)
    `);

    const txn = this.db.transaction(() => {
      const entityMap: Record<string, number> = {};

      // 1. Insert or update all entities and map their IDs
      for (const entity of entities) {
        const entityNs = entity.namespace || namespace;
        const res = insertEntityStmt.get({
          $namespace: entityNs,
          $name: entity.name,
          $type: entity.type,
        });

        if (res) {
          entityMap[entity.name] = res.id;
          if (entity.id !== undefined) {
            entityMap[String(entity.id)] = res.id;
          }
        }
      }

      // Helper to resolve entity to its internal database ID
      const resolveEntityId = (identifier: string | number): number => {
        const key = String(identifier);
        if (key in entityMap) {
          return entityMap[key];
        }

        // If identifier is already a number, verify or use directly
        if (typeof identifier === "number") {
          return identifier;
        }

        // Try looking up by name in the database within this namespace
        const existing = findEntityByNameStmt.get({
          $namespace: namespace,
          $name: identifier,
        });

        if (existing) {
          entityMap[identifier] = existing.id;
          return existing.id;
        }

        throw new Error(
          `Graph edge references unknown entity "${identifier}" in namespace "${namespace}". ` +
            `Ensure the entity is declared in the entities array or already exists in the database.`,
        );
      };

      // 2. Insert edges using resolved IDs
      let edgesCount = 0;
      for (const edge of edges) {
        const sourceId = resolveEntityId(edge.source);
        const targetId = resolveEntityId(edge.target);

        insertEdgeStmt.run({
          $source: sourceId,
          $target: targetId,
          $relation: edge.relation,
          $weight: edge.weight ?? 1.0,
        });
        edgesCount++;
      }

      return {
        namespace,
        entitiesInserted: entities.length,
        edgesInserted: edgesCount,
        entityMap,
      };
    });

    return txn();
  }
}

export default GraphIngestor;
