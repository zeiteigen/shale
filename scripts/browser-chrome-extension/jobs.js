import { settings } from "./settings.js";
import { storedJobs, saveJob } from "./outbox.js";
/** Jobs stored before modules existed are browser library imports. */
export const jobOwner = (job) => ({
  module: job.module || "browser",
  kind: job.kind || "library-import",
});
let running;
export async function jobs() {
  return (await storedJobs()).map((job) => ({ ...job, ...jobOwner(job) }));
}
/** Persist a resumable job; `fields` holds the module's own cursor and counters. */
export async function createJob(module, kind, fields = {}) {
  const config = await settings();
  const job = {
    counts: {},
    cursor: 0,
    warnings: [],
    ...fields,
    id: crypto.randomUUID(),
    module,
    kind,
    state: "running",
    endpoint: config.serverUrl,
    createdAt: Date.now(),
  };
  await saveJob(job);
  return job;
}
/**
 * Advance each module's oldest running job by up to `steps` steps. `handlerFor(job)` returns
 * the module's `{ step, summary, stepsPerWake? }`; a job stays bound to the server it was created for.
 * A step can set `job.yieldUntil` to pause the job until then.
 */
export function resumeJobs(handlerFor, steps = 20) {
  return (running ??= (async () => {
    const firstPerModule = new Map();
    for (const job of (await jobs()).sort((a, b) => a.createdAt - b.createdAt))
      if (job.state === "running" && !firstPerModule.has(job.module))
        firstPerModule.set(job.module, job);
    for (const job of firstPerModule.values()) {
      // A step may ask to pause the job, e.g. after a rate limit.
      if (job.yieldUntil > Date.now()) continue;
      const handler = handlerFor(job);
      const budget = handler?.stepsPerWake ?? steps;
      for (let i = 0; i < budget && job.state === "running"; i++) {
        const before = (await jobs()).find((saved) => saved.id === job.id);
        if (before?.state !== "running") break;
        try {
          if (!handler) throw new Error(`The ${job.module} module is unavailable`);
          const config = await settings();
          if (config.serverUrl !== job.endpoint)
            throw new Error(
              "Restore the import destination before resuming this job",
            );
          await handler.step(job);
          job.error = "";
        } catch (error) {
          job.state = "failed";
          job.error = error.message;
        }
        const after = (await jobs()).find((saved) => saved.id === job.id);
        if (after?.state === "cancelled") job.state = "cancelled";
        try {
          job.summary = handler?.summary?.(job) || "";
        } catch {}
        await saveJob(job, { keepCancellation: true });
        if (job.yieldUntil > Date.now()) break;
      }
    }
  })().finally(() => {
    running = undefined;
  }));
}
export async function updateJob(id, action) {
  const job = (await storedJobs()).find((job) => job.id === id);
  if (!job) throw new Error("Unknown import job");
  job.state = action === "cancel" ? "cancelled" : "running";
  job.error = "";
  await saveJob(job);
}
