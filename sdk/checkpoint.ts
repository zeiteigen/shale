import { Database } from "bun:sqlite";
import { randomUUIDv7 } from "bun";
import defaultDb from "../lib/db-init";
import type {
  CheckpointRecord,
  CheckpointItem,
  CheckpointContext,
  SaveCheckpointOptions,
} from "./types";

export class CheckpointManager {
  private readonly db: Database;
  readonly extensionId: string;

  constructor(extensionId: string, database?: Database) {
    if (!extensionId || typeof extensionId !== "string") {
      throw new Error("CheckpointManager requires a valid string extensionId.");
    }
    this.extensionId = extensionId;
    this.db = database ?? defaultDb;
  }

  private mapRecord<T>(record: CheckpointRecord): CheckpointItem<T> {
    let parsedData: any = record.data;
    try {
      parsedData = JSON.parse(record.data);
    } catch {
      parsedData = record.data;
    }
    return {
      id: record.id,
      extensionId: record.extension_id,
      key: record.checkpoint_key,
      data: parsedData as T,
      createdAt: record.created_at,
      status: record.status,
    };
  }

  /**
   * Saves a temporary checkpoint for this extension.
   * If a crash occurs, this checkpoint will be available in the recovery queue.
   */
  save<T = any>(
    data: T,
    optionsOrKey: string | SaveCheckpointOptions = "default",
  ): CheckpointItem<T> {
    let key = "default";
    let id: string = randomUUIDv7();
    let status = "queued";

    if (typeof optionsOrKey === "string") {
      key = optionsOrKey;
    } else if (optionsOrKey && typeof optionsOrKey === "object") {
      if (optionsOrKey.key) key = optionsOrKey.key;
      if (optionsOrKey.id) id = optionsOrKey.id;
      if (optionsOrKey.status) status = optionsOrKey.status;
    }

    const serializedData =
      typeof data === "string" ? data : JSON.stringify(data);
    const createdAt = Date.now();

    const stmt = this.db.query(`
      INSERT INTO checkpoints (id, extension_id, checkpoint_key, data, created_at, status)
      VALUES ($id, $extension_id, $checkpoint_key, $data, $created_at, $status)
      ON CONFLICT(id) DO UPDATE SET
        extension_id = excluded.extension_id,
        checkpoint_key = excluded.checkpoint_key,
        data = excluded.data,
        created_at = excluded.created_at,
        status = excluded.status
    `);

    stmt.run({
      $id: id,
      $extension_id: this.extensionId,
      $checkpoint_key: key,
      $data: serializedData,
      $created_at: createdAt,
      $status: status,
    });

    return {
      id,
      extensionId: this.extensionId,
      key,
      data,
      createdAt,
      status,
    };
  }

  /**
   * Retrieves all queued checkpoints for this extension in FIFO order.
   */
  getQueue<T = any>(): CheckpointItem<T>[] {
    const stmt = this.db.query<CheckpointRecord, { $extension_id: string }>(`
      SELECT id, extension_id, checkpoint_key, data, created_at, status
      FROM checkpoints
      WHERE extension_id = $extension_id AND status = 'queued'
      ORDER BY created_at ASC
    `);
    const rows = stmt.all({ $extension_id: this.extensionId });
    return rows.map((r) => this.mapRecord<T>(r));
  }

  /**
   * Retrieves all checkpoints for this extension regardless of status.
   */
  getAll<T = any>(): CheckpointItem<T>[] {
    const stmt = this.db.query<CheckpointRecord, { $extension_id: string }>(`
      SELECT id, extension_id, checkpoint_key, data, created_at, status
      FROM checkpoints
      WHERE extension_id = $extension_id
      ORDER BY created_at ASC
    `);
    const rows = stmt.all({ $extension_id: this.extensionId });
    return rows.map((r) => this.mapRecord<T>(r));
  }

  /**
   * Retrieves a single checkpoint by its ID or key.
   */
  get<T = any>(keyOrId: string): CheckpointItem<T> | null {
    const stmt = this.db.query<
      CheckpointRecord,
      { $extension_id: string; $val: string }
    >(`
      SELECT id, extension_id, checkpoint_key, data, created_at, status
      FROM checkpoints
      WHERE extension_id = $extension_id AND (id = $val OR checkpoint_key = $val)
      ORDER BY created_at DESC
      LIMIT 1
    `);
    const row = stmt.get({ $extension_id: this.extensionId, $val: keyOrId });
    return row ? this.mapRecord<T>(row) : null;
  }

  /**
   * Returns whether this extension has any checkpoints currently queued.
   */
  hasQueued(): boolean {
    const stmt = this.db.query<{ one: number }, { $extension_id: string }>(`
      SELECT 1 as one FROM checkpoints
      WHERE extension_id = $extension_id AND status = 'queued'
      LIMIT 1
    `);
    return !!stmt.get({ $extension_id: this.extensionId });
  }

  /**
   * Alias for hasQueued().
   */
  hasCheckpoints(): boolean {
    return this.hasQueued();
  }

  /**
   * Returns context object containing queued checkpoints and recovery helper methods.
   */
  getContext<T = any>(): CheckpointContext<T> {
    const queue = this.getQueue<T>();
    return {
      extensionId: this.extensionId,
      checkpoints: queue,
      count: queue.length,
      latest: queue.length > 0 ? queue[queue.length - 1] : null,
      earliest: queue.length > 0 ? queue[0] : null,
      clear: () => this.clear(),
      resolve: (id: string) => this.resolve(id),
      get: (key: string) => queue.find((item) => item.key === key),
    };
  }

  /**
   * Deletes a checkpoint by ID or key.
   */
  delete(idOrKey: string): boolean {
    const stmt = this.db.query(`
      DELETE FROM checkpoints
      WHERE (id = $val OR checkpoint_key = $val) AND extension_id = $extension_id
    `);
    const res = stmt.run({ $val: idOrKey, $extension_id: this.extensionId });
    return res.changes > 0;
  }

  /**
   * Resolves a checkpoint by removing it from the active queue.
   */
  resolve(id: string): boolean {
    return this.delete(id);
  }

  /**
   * Clears all queued checkpoints for this extension.
   */
  clear(): number {
    const stmt = this.db.query(`
      DELETE FROM checkpoints
      WHERE extension_id = $extension_id AND status = 'queued'
    `);
    const res = stmt.run({ $extension_id: this.extensionId });
    return res.changes;
  }

  /**
   * Clears all checkpoints for this extension.
   */
  clearAll(): number {
    const stmt = this.db.query(`
      DELETE FROM checkpoints
      WHERE extension_id = $extension_id
    `);
    const res = stmt.run({ $extension_id: this.extensionId });
    return res.changes;
  }
}

export default CheckpointManager;
