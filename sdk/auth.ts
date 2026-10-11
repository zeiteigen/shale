import type { ShaleSDK } from "./extension-sdk";

/**
 * Account connection contract for extensions. A manifest's `auth_script` exports
 * `auth` (or a default export) implementing this; the host exposes it on the local
 * web interface under /api/auth so accounts are connected from the browser.
 * Secrets go into `sdk.credentials` and are never returned to the browser.
 */
export interface AuthField {
  key: string;
  label: string;
  type: "text" | "password";
  required?: boolean;
  placeholder?: string;
  help?: string;
}

export interface AuthMethod {
  id: string;
  label: string;
  description?: string;
  fields: AuthField[];
}

export interface AuthStatus {
  connected: boolean;
  /** Human-readable account label, e.g. a username. */
  account?: string;
  detail?: string;
  checkedAt?: number;
  /** A multi-step login is waiting for the user, e.g. a 2FA or security-challenge code. */
  pending?: { prompt: string; field: AuthField };
  /** The last connect/verify attempt failed with this message. */
  error?: string;
}

export interface AuthProvider {
  title: string;
  description?: string;
  /** Shown prominently, e.g. Terms-of-Service risk of unofficial APIs. */
  warning?: string;
  methods: AuthMethod[];
  status(sdk: ShaleSDK): AuthStatus | Promise<AuthStatus>;
  connect(sdk: ShaleSDK, method: string, values: Record<string, string>): Promise<AuthStatus>;
  /** Continue a pending multi-step login. */
  submit?(sdk: ShaleSDK, values: Record<string, string>): Promise<AuthStatus>;
  /** Re-check stored credentials against the service. */
  verify?(sdk: ShaleSDK): Promise<AuthStatus>;
  disconnect(sdk: ShaleSDK): void | Promise<void>;
}

export function isAuthProvider(value: unknown): value is AuthProvider {
  const provider = value as AuthProvider;
  return !!provider && typeof provider === "object" && typeof provider.title === "string" && Array.isArray(provider.methods)
    && typeof provider.status === "function" && typeof provider.connect === "function" && typeof provider.disconnect === "function";
}
