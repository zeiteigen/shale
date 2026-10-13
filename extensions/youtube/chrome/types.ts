/** The shared Chrome core's runtime contract, without coupling to another extension. */
export interface ModuleRuntime {
  id: string;
  enqueue(records: unknown[]): Promise<void>;
  hasRecord(id: string): Promise<unknown>;
  deliver(): Promise<void>;
  storage: { get<T>(name: string, fallback?: T): Promise<T>; set(name: string, value: unknown): Promise<void> };
  policy(): Promise<Record<string, any> | undefined>;
  enabled(): Promise<boolean>;
  inject<T>(tabId: number, name: string, options?: { documentId?: string; args?: unknown; world?: "ISOLATED" | "MAIN" }): Promise<T>;
  log(...items: unknown[]): void;
}
export interface ModuleDefinition {
  id: string; label: string;
  protocol: { batchType: string; version: number; validate(value: unknown): unknown };
  claims?: { match(url: URL): boolean };
  wake?(): Promise<unknown>;
  status?(): Promise<unknown>;
  listeners?: Partial<{
    navigation(details: chrome.webNavigation.WebNavigationTransitionCallbackDetails): unknown;
    tabComplete(id: number, tab: chrome.tabs.Tab): unknown;
    tabActivated(info: chrome.tabs.OnActivatedInfo): unknown;
    tabRemoved(id: number): unknown;
    alarm(): unknown;
  }>;
  actions?: Record<string, (request: Record<string, any>) => unknown>;
}
export interface PopupApi {
  command(action: string, extra?: Record<string, unknown>): Promise<any>;
  act(work: () => Promise<unknown>): Promise<void>;
  feedback(message: string, error?: boolean): void;
}
