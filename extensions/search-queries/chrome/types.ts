/**
 * The Chrome extension core's module API (scripts/browser-chrome-extension/core/module-host.js),
 * typed for this module. See the Chrome extension README for the full contract.
 */
export interface ModuleJob {
  id: string;
  state: "running" | "completed" | "failed" | "cancelled" | "incomplete";
  counts: Record<string, number>;
  warnings: string[];
  error?: string;
  /** Pause this job until then (epoch ms). */
  yieldUntil?: number;
  [field: string]: unknown;
}

export interface ModuleRuntime {
  id: string;
  settings(): Promise<Record<string, any>>;
  enqueue(records: unknown[]): Promise<void>;
  hasRecord(id: string): Promise<unknown>;
  deliver(): Promise<void>;
  storage: { get<T>(name: string, fallback?: T): Promise<T>; set(name: string, value: unknown): Promise<void> };
  policy(): Promise<Record<string, any> | undefined>;
  enabled(): Promise<boolean>;
  claimedByOther(url: string): Promise<boolean>;
  createJob(kind: string, fields: Record<string, unknown>): Promise<ModuleJob>;
  resume(): Promise<void>;
  inject<T>(tabId: number, name: string, options?: { documentId?: string; args?: unknown }): Promise<T>;
  execInTab<T, A extends unknown[]>(tabId: number, func: (...args: A) => T | Promise<T>, args: A): Promise<Awaited<T>>;
  log(...items: unknown[]): void;
}

export interface ModuleDefinition {
  id: string;
  label?: string;
  protocol: { batchType: string; version: number; validate(batch: unknown): unknown };
  /** Hosts this module owns, and/or a predicate for individual URLs it owns. */
  claims?: { hosts?: string[]; match?(url: URL): boolean };
  defaults?: Record<string, unknown>;
  wake?(): Promise<unknown> | unknown;
  status?(): Promise<unknown> | unknown;
  listeners?: Partial<{
    alarm(): unknown;
    navigation(details: chrome.webNavigation.WebNavigationTransitionCallbackDetails): unknown;
    tabComplete(tabId: number, tab: chrome.tabs.Tab): unknown;
    tabActivated(info: chrome.tabs.OnActivatedInfo): unknown;
    tabRemoved(tabId: number): unknown;
  }>;
  actions?: Record<string, (request: Record<string, any>) => unknown>;
  jobs?: Record<string, { step(job: ModuleJob): Promise<void>; summary?(job: ModuleJob): string; stepsPerWake?: number }>;
}

export interface PopupApi {
  id: string;
  command(action: string, extra?: Record<string, unknown>): Promise<any>;
  act(work: () => Promise<unknown>): Promise<void>;
  feedback(message: string, error?: boolean): void;
}
