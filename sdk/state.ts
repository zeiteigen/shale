import { Database } from "bun:sqlite";
import defaultDb from "../lib/db-init";
import type { ExtensionStateRecord } from "./types";

export class StateManager {
  private readonly db: Database;
  readonly extensionId: string;

  constructor(extensionId: string, database?: Database) {
    if (!extensionId || typeof extensionId !== "string") {
      throw new Error("StateManager requires a valid string extensionId.");
    }
    this.extensionId = extensionId;
    this.db = database ?? defaultDb;
  }

  /**
   * Retrieves the raw string value for a given state key scoped to this extension.
   */
  get(key: string): string | null {
    const stmt = this.db.query<
      { value: string },
      { $extension_id: string; $state_key: string }
    >(`
      SELECT value FROM extension_state
      WHERE extension_id = $extension_id AND state_key = $state_key
    `);
    const res = stmt.get({
      $extension_id: this.extensionId,
      $state_key: key,
    });
    return res ? res.value : null;
  }

  /**
   * Sets or updates a state key with a string value for this extension.
   */
  set(key: string, value: string): void {
    const stmt = this.db.query(`
      INSERT INTO extension_state (extension_id, state_key, value, updated_at)
      VALUES ($extension_id, $state_key, $value, $updated_at)
      ON CONFLICT(extension_id, state_key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);
    stmt.run({
      $extension_id: this.extensionId,
      $state_key: key,
      $value: value,
      $updated_at: Date.now(),
    });
  }

  /**
   * Deletes a state key for this extension.
   */
  delete(key: string): boolean {
    const stmt = this.db.query(`
      DELETE FROM extension_state
      WHERE extension_id = $extension_id AND state_key = $state_key
    `);
    const res = stmt.run({
      $extension_id: this.extensionId,
      $state_key: key,
    });
    return res.changes > 0;
  }

  /**
   * Gets the watermark/cursor for this extension.
   * If key is omitted, defaults to "watermark".
   */
  getWatermark(key: string = "watermark"): string | null {
    return this.get(key);
  }

  /**
   * Updates the watermark/cursor for this extension.
   * If key is omitted, defaults to "watermark".
   */
  setWatermark(value: string, key: string = "watermark"): void {
    this.set(key, value);
  }

  /**
   * Helper to retrieve and parse a JSON-encoded state value.
   */
  getJson<T = unknown>(key: string): T | null {
    const raw = this.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  /**
   * Helper to serialize and store a JSON-encoded state value.
   */
  setJson<T = unknown>(key: string, value: T): void {
    this.set(key, JSON.stringify(value));
  }

  /**
   * Retrieves all state records scoped to this extension.
   */
  getAll(): ExtensionStateRecord[] {
    const stmt = this.db.query<
      ExtensionStateRecord,
      { $extension_id: string }
    >(`
      SELECT extension_id, state_key, value, updated_at
      FROM extension_state
      WHERE extension_id = $extension_id
      ORDER BY state_key ASC
    `);
    return stmt.all({ $extension_id: this.extensionId });
  }
}

export default StateManager;
