import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Host/ambient SDK tests must never mutate the user's production index.
const directory = mkdtempSync(join(tmpdir(), "shale-tests-"));
process.env.SHALE_DB_PATH = join(directory, "test.db");
afterAll(() => rmSync(directory, { recursive: true, force: true }));
