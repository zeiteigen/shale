import type { CronExtension } from "../lib/extension";

export interface CronRun {
  status: "running" | "succeeded" | "failed";
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

const states = new WeakMap<CronExtension, CronRun>();
const inFlight = new WeakMap<CronExtension, Promise<void>>();
export function getCronRun(cron: CronExtension) { return states.get(cron); }

/** Scheduled, startup and manual triggers share execution state and coalesce duplicates. */
export function trackCronRun(cron: CronExtension, run: () => Promise<void>): Promise<void> {
  const current = inFlight.get(cron);
  if (current) return current;
  const state: CronRun = { status: "running", startedAt: Date.now() };
  states.set(cron, state);
  const promise = Promise.resolve().then(run).then(() => {
    state.status = "succeeded";
  }).catch(error => {
    state.status = "failed";
    state.error = String(error instanceof Error ? error.message : error).slice(0, 8000);
    throw error;
  }).finally(() => {
    state.finishedAt = Date.now();
    inFlight.delete(cron);
  });
  inFlight.set(cron, promise);
  return promise;
}
