import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
// Chrome globals and IndexedDB connections remain isolated from other Bun test files.
test("Chrome defaults, stable receipts, offline retries and import cursors survive reinitialization", () => {
  const result = spawnSync(
    process.execPath,
    ["run", `${import.meta.dir}/fixtures/chrome-outbox.mjs`],
    { encoding: "utf8" },
  );
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("Chrome outbox checks passed");
});
