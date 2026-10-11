import { credentialStore } from "../lib/credentials";

/** Per-extension view of the local credential store (`data/credentials.json`). */
export class ExtensionCredentials {
  constructor(private readonly extensionId: string) {}

  get(key: string): string | undefined {
    return credentialStore.get(this.extensionId, key);
  }

  /** Stored value first, then the named environment variable (e.g. from data/.env). */
  resolve(key: string, envName?: string): string | undefined {
    const stored = this.get(key)?.trim();
    if (stored) return stored;
    const fromEnv = envName ? process.env[envName]?.trim() : undefined;
    return fromEnv || undefined;
  }

  all(): Record<string, string> {
    return credentialStore.all(this.extensionId);
  }

  set(values: Record<string, string | null>) {
    credentialStore.set(this.extensionId, values);
  }

  clear() {
    credentialStore.clear(this.extensionId);
  }
}
