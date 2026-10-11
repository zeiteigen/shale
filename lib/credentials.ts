import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type CredentialFile = Record<string, Record<string, string>>;

/** `data/credentials.json` unless SHALE_CREDENTIALS_PATH points elsewhere (tests, alternate profiles). */
export function credentialsPath(): string {
  return process.env.SHALE_CREDENTIALS_PATH || join(import.meta.dir, "../data/credentials.json");
}

function read(path = credentialsPath()): CredentialFile {
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function write(data: CredentialFile, path = credentialsPath()) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  // Owner-only from creation; the rename keeps readers from seeing a partial file.
  writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

/**
 * Local secrets for connectors, read from disk on every call like settings.
 * Values never leave the host: the web API reports only which keys are set.
 */
export const credentialStore = {
  get(extensionId: string, key: string): string | undefined {
    return read()[extensionId]?.[key];
  },
  all(extensionId: string): Record<string, string> {
    return { ...read()[extensionId] };
  },
  /** Merge values for one extension; `null` removes a key. */
  set(extensionId: string, values: Record<string, string | null>) {
    const data = read();
    const entry = { ...data[extensionId] };
    for (const [key, value] of Object.entries(values)) {
      if (value === null) delete entry[key];
      else entry[key] = value;
    }
    if (Object.keys(entry).length) data[extensionId] = entry;
    else delete data[extensionId];
    write(data);
  },
  clear(extensionId: string) {
    const data = read();
    if (!(extensionId in data)) return;
    delete data[extensionId];
    write(data);
  },
};
