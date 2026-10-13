import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// Chrome globals and IndexedDB connections stay isolated from other Bun test files.
test("Chrome modules route records, claims, jobs, and actions per Shale extension", () => {
  const result = spawnSync(process.execPath, ["run", `${import.meta.dir}/fixtures/chrome-modules.mjs`], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("Chrome module checks passed");
});

test("generated Chrome module bundles match their extension sources", () => {
  const result = spawnSync(process.execPath, ["run", join(import.meta.dir, "../scripts/build-browser-modules.ts"), "--check"],
    { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});
