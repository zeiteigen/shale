import { createExtensionSDK, type ShaleSDK } from "./extension-sdk";
import { resolveProfile, type ResolvedProfile } from "../lib/access/policy";
import { ScopedDatabase } from "../lib/access/scoped-database";
import { AccessWriteGuard } from "../lib/access/write-guard";

export interface ScopedSDK {
  profile: ResolvedProfile;
  /** Sees only the records the profile may access; it cannot write. */
  read: ShaleSDK;
  /** Writes through the shared connection, checked against the profile's scope. */
  write: ShaleSDK;
  guard?: AccessWriteGuard;
  scoped?: ScopedDatabase;
  /** Re-derive visibility from the current policy, labels, and data. */
  refresh(): ResolvedProfile;
}

const cache = new Map<string, ScopedSDK>();

/**
 * SDK pair for an access profile, for MCP sessions and any other consumer that must respect
 * the user's data permissions. Unrestricted profiles share `base`; restricted ones get a
 * cached read-only connection whose views hide everything outside the profile.
 */
export function createScopedSDK(profileName: string, base: ShaleSDK = createExtensionSDK("access", { namespace: "knowledge" })): ScopedSDK {
  const profile = resolveProfile(profileName);
  if (profile.unrestricted) return { profile, read: base, write: base, refresh: () => resolveProfile(profileName) };
  const path = base.database.filename;
  const key = `${path}\u0000${profileName}\u0000${base.namespace}`;
  const cached = cache.get(key);
  if (cached) { cached.refresh(); return cached; }
  const scoped = new ScopedDatabase(profileName, base.database, path);
  const read = createExtensionSDK(`${base.extensionId}:${profileName}`, { namespace: base.namespace, database: scoped.db });
  scoped.seal();
  scoped.refresh();
  const write = createExtensionSDK(base.extensionId, { namespace: base.namespace, database: base.database });
  const guard = new AccessWriteGuard({ scoped, visibleGraph: read.graph, writer: base.database });
  write.knowledge.setGuard(guard);
  const entry: ScopedSDK = { profile, read, write, guard, scoped, refresh: () => (entry.profile = scoped.refresh()) };
  cache.set(key, entry);
  return entry;
}

/** Close cached scoped connections (tests, shutdown). */
export function closeScopedSDKs() {
  for (const entry of cache.values()) entry.scoped?.close();
  cache.clear();
}
