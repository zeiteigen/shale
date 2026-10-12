export interface Task {
  id: string;
  label: string;
  status: "running" | "succeeded" | "failed";
  startedAt: number;
  finishedAt?: number;
  output?: string;
}
export interface Cron {
  id: string;
  name?: string;
  extensionId?: string;
  schedule: string;
  run_on_startup?: boolean;
  lastRun?: { status: Task["status"]; startedAt: number; finishedAt?: number; error?: string };
}
export interface Host {
  status: string;
  port: number;
  uptime: number;
  memoryMB: number;
  extensions: { name: string; namespace: string }[];
  crons: Cron[];
  tasks: Task[];
}
export interface LogEntry { id: number; time: number; level: string; text: string }
export interface SettingsTarget { name: string; title: string; description: string; hasSettings: boolean; hasHelp: boolean }
export interface SettingSchema {
  type: string;
  description: string;
  default?: unknown;
  possibleValues?: unknown[];
  range?: { min?: number; max?: number };
  integer?: boolean;
  format?: string;
}
export interface SettingsDocument { name: string; values: Record<string, unknown>; schema: Record<string, SettingSchema> }
export interface AuthField { key: string; label: string; type: "text" | "password"; required?: boolean; placeholder?: string; help?: string }
export interface AuthMethod { id: string; label: string; description?: string; fields: AuthField[] }
export interface AuthStatus {
  connected: boolean;
  account?: string;
  detail?: string;
  checkedAt?: number;
  pending?: { prompt: string; field: AuthField };
  error?: string;
}
export interface AuthAccount {
  extension: string;
  title: string;
  description?: string;
  warning?: string;
  methods: AuthMethod[];
  canVerify: boolean;
  status: AuthStatus;
}
export type AccessTier = "public" | "personal" | "private" | "secret";
export interface SourceMatch { origin?: string; type?: string; uri?: string }
export interface AccessProfile { description?: string; clearance: AccessTier; allow?: SourceMatch[]; deny?: SourceMatch[]; write?: boolean }
export interface AccessPolicy {
  defaultTier: AccessTier;
  unauthenticatedProfile: string | null;
  originTiers: Record<string, AccessTier>;
  tierRules: Array<{ match: SourceMatch; tier: AccessTier }>;
  profiles: Record<string, AccessProfile>;
}
export interface AccessToken { id: string; profile: string; label: string; createdAt: number }
export interface AccessOverview {
  tiers: AccessTier[];
  policy: AccessPolicy;
  tokens: AccessToken[];
  origins: Array<{ origin: string; n: number }>;
  classification: { sources: number; heuristic: number; llm: number; manual: number };
}
export interface ProfilePreview {
  unrestricted?: boolean;
  sources?: number;
  entities?: number;
  claims?: number;
  origins?: Array<{ origin: string; n: number }>;
  error?: string;
}
export interface RecordAccess {
  kind: string;
  id: string;
  tier: AccessTier | null;
  labels: Array<{ origin: "manual" | "heuristic" | "llm"; tier: AccessTier; hard: boolean; reason: string; updatedAt: number }>;
}
