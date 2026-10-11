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
