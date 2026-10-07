import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configureDatabaseConnection } from "../lib/database-connection";

test("a connection waits for another process's short write transaction", async () => {
  const directory = mkdtempSync(join(tmpdir(), "shale-contention-"));
  const path = join(directory, "database.db");
  const database = new Database(path);
  let writer: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    configureDatabaseConnection(database);
    database.run("CREATE TABLE example(value INTEGER)");
    writer = Bun.spawn([process.execPath, "-e", `
      const {Database} = require('bun:sqlite');
      const db = new Database(process.argv[1]);
      db.run('BEGIN IMMEDIATE');
      db.run('INSERT INTO example VALUES(1)');
      process.stdout.write('locked\\n');
      setTimeout(() => { db.run('COMMIT'); db.close(); }, 250);
    `, path], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const reader = writer.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked");
    reader.releaseLock();
    database.run("INSERT INTO example VALUES(2)");
    expect(await writer.exited).toBe(0);
    expect(database.query("SELECT value FROM example ORDER BY value").all()).toEqual([{value:1},{value:2}]);
    expect(database.query("PRAGMA busy_timeout").get()).toEqual({timeout:5000});
    expect(database.query("PRAGMA foreign_keys").get()).toEqual({foreign_keys:1});
  } finally {
    if (writer) { writer.kill(); await writer.exited; }
    database.close();
    rmSync(directory, {recursive:true,force:true});
  }
});
