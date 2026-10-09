import { fileURLToPath } from "node:url";

// Bun only auto-loads .env from the working directory. Load the project data
// directory explicitly so scripts and SDK consumers also receive credentials.
try {
  process.loadEnvFile(fileURLToPath(new URL("../data/.env", import.meta.url)));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
