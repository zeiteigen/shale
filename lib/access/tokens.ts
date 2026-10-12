import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { credentialStore } from "../credentials";
import { readAccessPolicy } from "./policy";

/** Token hashes live in data/credentials.json under this key; plaintext is shown once at creation. */
const STORE = "access";

interface TokenRecord { profile: string; label: string; createdAt: number }

function hash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function records(): Record<string, TokenRecord> {
  const entries: Record<string, TokenRecord> = {};
  for (const [key, value] of Object.entries(credentialStore.all(STORE))) {
    try { entries[key] = JSON.parse(value); } catch {}
  }
  return entries;
}

export interface AccessToken { id: string; profile: string; label: string; createdAt: number }

export function listTokens(): AccessToken[] {
  return Object.entries(records()).map(([key, record]) => ({ id: key.slice(0, 12), ...record }))
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function createToken(profile: string, label = ""): { token: string } & AccessToken {
  if (!readAccessPolicy().profiles[profile]) throw new Error(`Unknown access profile "${profile}"`);
  const token = `shale_${randomBytes(24).toString("base64url")}`;
  const record: TokenRecord = { profile, label: label.slice(0, 100), createdAt: Date.now() };
  const key = hash(token);
  credentialStore.set(STORE, { [key]: JSON.stringify(record) });
  return { token, id: key.slice(0, 12), ...record };
}

export function revokeToken(id: string): boolean {
  const key = Object.keys(records()).find(k => k.startsWith(id) && id.length >= 12);
  if (!key) return false;
  credentialStore.set(STORE, { [key]: null });
  return true;
}

export class AccessDeniedError extends Error {
  readonly status = 401;
}

/** Map an Authorization header to a profile name. Throws when the token is invalid or one is required. */
export function profileForRequest(authorization: string | undefined | null): string {
  const policy = readAccessPolicy();
  if (!authorization) {
    if (policy.unauthenticatedProfile === null) throw new AccessDeniedError("An access token is required");
    return policy.unauthenticatedProfile;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  if (!match) throw new AccessDeniedError("Authorization must be a Bearer token");
  const digest = Buffer.from(hash(match[1]!), "hex");
  for (const [key, record] of Object.entries(records())) {
    if (key.length === digest.length * 2 && timingSafeEqual(Buffer.from(key, "hex"), digest)) {
      if (!policy.profiles[record.profile]) throw new AccessDeniedError("The token's profile no longer exists");
      return record.profile;
    }
  }
  throw new AccessDeniedError("Invalid access token");
}
