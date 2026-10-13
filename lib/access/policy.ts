import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Ordered from least to most sensitive; a profile sees records at or below its clearance. */
export const TIERS = ["public", "personal", "private", "secret"] as const;
export type Tier = (typeof TIERS)[number];
export const SECRET = TIERS.length - 1;

/** GLOB patterns (SQLite syntax, case-sensitive) matched against a source's columns. */
export interface SourceMatch {
  origin?: string;
  type?: string;
  uri?: string;
}

export interface AccessProfile {
  description?: string;
  clearance: Tier;
  /** When non-empty, only sources matching at least one entry are visible. */
  allow?: SourceMatch[];
  /** Sources matching any entry are hidden regardless of tier. */
  deny?: SourceMatch[];
  /** Restricted profiles may edit only records they can see. */
  write?: boolean;
}

export interface AccessPolicy {
  /** Floor for sources no rule or origin tier covers. */
  defaultTier: Tier;
  /** Profile for requests without a token; null requires a token. */
  unauthenticatedProfile: string | null;
  originTiers: Record<string, Tier>;
  tierRules: Array<{ match: SourceMatch; tier: Tier }>;
  profiles: Record<string, AccessProfile>;
}

export interface ResolvedProfile extends AccessProfile {
  name: string;
  /** True when the profile sees everything, so no filtering is needed. */
  unrestricted: boolean;
}

export const DEFAULT_POLICY: AccessPolicy = {
  defaultTier: "personal",
  unauthenticatedProfile: "local",
  originTiers: { discord: "private", instagram: "private", email: "private", chatgpt: "private", claude: "private", gemini: "private" },
  tierRules: [],
  profiles: {
    local: { description: "Agents running on this machine", clearance: "secret", write: true },
    cloud: { description: "Hosted agents; personal data only, no private messages", clearance: "personal", write: true },
  },
};

export function accessPolicyPath(): string {
  return process.env.SHALE_ACCESS_PATH ?? join(import.meta.dir, "../../data/access.json");
}

export function tierIndex(tier: Tier): number {
  return TIERS.indexOf(tier);
}

function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

function validateMatch(match: unknown, where: string): SourceMatch {
  if (!match || typeof match !== "object" || Array.isArray(match)) throw new Error(`${where} must be an object`);
  const result: SourceMatch = {};
  for (const [key, value] of Object.entries(match)) {
    if (!["origin", "type", "uri"].includes(key)) throw new Error(`${where} has unknown field "${key}"`);
    if (typeof value !== "string" || !value) throw new Error(`${where}.${key} must be a non-empty pattern`);
    result[key as keyof SourceMatch] = value;
  }
  if (!Object.keys(result).length) throw new Error(`${where} must match at least one of origin, type, or uri`);
  return result;
}

/** Throws a descriptive error for any invalid field; returns a normalized copy. */
export function validateAccessPolicy(input: unknown): AccessPolicy {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Access policy must be a JSON object");
  const raw = input as Record<string, unknown>;
  const defaultTier = raw.defaultTier ?? DEFAULT_POLICY.defaultTier;
  if (!isTier(defaultTier)) throw new Error(`defaultTier must be one of ${TIERS.join(", ")}`);
  const originTiers: Record<string, Tier> = {};
  for (const [origin, tier] of Object.entries((raw.originTiers ?? {}) as Record<string, unknown>)) {
    if (!isTier(tier)) throw new Error(`originTiers.${origin} must be one of ${TIERS.join(", ")}`);
    originTiers[origin] = tier;
  }
  if (!Array.isArray(raw.tierRules ?? [])) throw new Error("tierRules must be an array");
  const tierRules = ((raw.tierRules ?? []) as unknown[]).map((rule, i) => {
    const entry = rule as { match?: unknown; tier?: unknown };
    if (!isTier(entry?.tier)) throw new Error(`tierRules[${i}].tier must be one of ${TIERS.join(", ")}`);
    return { match: validateMatch(entry.match, `tierRules[${i}].match`), tier: entry.tier };
  });
  const profiles: Record<string, AccessProfile> = {};
  const rawProfiles = raw.profiles ?? DEFAULT_POLICY.profiles;
  if (!rawProfiles || typeof rawProfiles !== "object" || Array.isArray(rawProfiles)) throw new Error("profiles must be an object");
  for (const [name, value] of Object.entries(rawProfiles)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) throw new Error(`Profile name "${name}" must be lowercase letters, digits, - or _`);
    const profile = value as Record<string, unknown>;
    if (!isTier(profile?.clearance)) throw new Error(`profiles.${name}.clearance must be one of ${TIERS.join(", ")}`);
    const list = (key: "allow" | "deny") => {
      const items = profile[key] ?? [];
      if (!Array.isArray(items)) throw new Error(`profiles.${name}.${key} must be an array`);
      return items.map((item, i) => validateMatch(item, `profiles.${name}.${key}[${i}]`));
    };
    profiles[name] = {
      ...(typeof profile.description === "string" ? { description: profile.description } : {}),
      clearance: profile.clearance,
      allow: list("allow"),
      deny: list("deny"),
      write: profile.write !== false,
    };
  }
  if (!Object.keys(profiles).length) throw new Error("At least one profile is required");
  const unauthenticatedProfile = raw.unauthenticatedProfile === undefined ? DEFAULT_POLICY.unauthenticatedProfile : raw.unauthenticatedProfile;
  if (unauthenticatedProfile !== null && (typeof unauthenticatedProfile !== "string" || !profiles[unauthenticatedProfile]))
    throw new Error("unauthenticatedProfile must name a defined profile or be null");
  return { defaultTier, unauthenticatedProfile, originTiers, tierRules, profiles };
}

/** Read fresh on every call. A missing file is created with the defaults so tiers exist without setup. */
export function readAccessPolicy(): AccessPolicy {
  const path = accessPolicyPath();
  if (!existsSync(path)) {
    try { writeAccessPolicy(DEFAULT_POLICY); } catch {}
    return structuredClone(DEFAULT_POLICY);
  }
  return validateAccessPolicy(JSON.parse(readFileSync(path, "utf8")));
}

export function writeAccessPolicy(policy: unknown): AccessPolicy {
  const valid = validateAccessPolicy(policy);
  const path = accessPolicyPath();
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(valid, null, 2)}\n`);
  renameSync(temp, path);
  return valid;
}

/** Cheap change detector for callers that cache derived state. */
export function accessPolicyStamp(): string {
  try { return String(statSync(accessPolicyPath()).mtimeMs); } catch { return "default"; }
}

export function resolveProfile(name: string, policy = readAccessPolicy()): ResolvedProfile {
  const profile = policy.profiles[name];
  if (!profile) throw new Error(`Unknown access profile "${name}"`);
  const unrestricted = profile.clearance === "secret" && !profile.allow?.length && !profile.deny?.length;
  return { ...profile, name, unrestricted };
}
