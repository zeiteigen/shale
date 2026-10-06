import { format } from "node:util";

export interface WebLog { id: number; time: number; level: string; text: string }

/** Bounded output shared by all browser clients, while retaining terminal logging. */
export class WebLogs {
  private entries: WebLog[] = [];
  private nextId = 1;

  add(level: string, message: string) {
    this.entries.push({ id: this.nextId++, time: Date.now(), level, text: message.replace(/\x1b\[[0-9;]*m/g, "").slice(0, 8000) });
    if (this.entries.length > 500) this.entries.shift();
  }
  list() { return this.entries.map(entry => ({ ...entry })); }

  captureConsole() {
    const restore: (() => void)[] = [];
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
      const original = console[level];
      const wrapper = (...args: unknown[]) => {
        this.add(level, format(...args));
        original.apply(console, args);
      };
      console[level] = wrapper;
      restore.push(() => { if (console[level] === wrapper) console[level] = original; });
    }
    return () => restore.forEach(fn => fn());
  }
}
