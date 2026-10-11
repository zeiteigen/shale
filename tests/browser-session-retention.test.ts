import { expect, it } from "bun:test";
import { browserFixture } from "./fixtures/browser-connector";
import { browserStatus } from "../extensions/browser/status";
import { ensureBrowserSchema } from "../extensions/browser/storage-schema";

it("expires prepared session bodies and checkpoints after 24 hours", () => {
  const f = browserFixture();
  try {
    ensureBrowserSchema(f.database);
    const sessionId = "expired-session";
    const checkpointId = `browser_session:${sessionId}`;
    const prepared = { sessionId, visits: [{ title: "Retained body" }], settings: { token: "snapshot" } };
    f.sdk.checkpoint.save({ type: "browser_session_analysis", ...prepared }, { id: checkpointId, key: checkpointId });
    f.database.query(
      `INSERT INTO browser_sessions(extension_id,session_id,collector_id,activity_hash,start_time,end_time,boundary_reason,
        prepared,settings,prepared_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
    ).run(f.sdk.extensionId, sessionId, "collector", "event-list", 1, 1, "idle",
      JSON.stringify(prepared), JSON.stringify(prepared.settings), Date.now() - 25 * 60 * 60 * 1000);
    f.database.query("UPDATE checkpoints SET created_at=? WHERE extension_id=? AND id=?")
      .run(Date.now() - 25 * 60 * 60 * 1000, f.sdk.extensionId, checkpointId);

    browserStatus(f.sdk);

    const row = f.database.query<any, [string, string]>(
      "SELECT prepared,settings,attempts,error FROM browser_sessions WHERE extension_id=? AND session_id=?",
    ).get(f.sdk.extensionId, sessionId);
    expect(row.prepared).toBeNull();
    expect(row.settings).toBeNull();
    expect(row.attempts).toBeGreaterThan(1000);
    expect(row.error).toContain("expired after 24 hours");
    expect(f.sdk.checkpoint.get(checkpointId)).toBeNull();
  } finally { f.database.close(); }
});
