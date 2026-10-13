import type { CronExtension } from '../lib/extension';

/** Independent extensions start together; each extension keeps its own startup order. */
export async function runStartupJobs(crons: readonly CronExtension[], run: (cron: CronExtension) => Promise<void>,
  failed: (cron: CronExtension, error: unknown) => void) {
  const queues = new Map<string, Promise<void>>();
  for (const cron of crons) {
    if (!cron.run_on_startup) continue;
    const extension = cron.extensionId ?? 'default';
    const previous = queues.get(extension) ?? Promise.resolve();
    queues.set(extension, previous.then(async () => {
      try { await run(cron); }
      catch (error) { failed(cron, error); }
    }));
  }
  await Promise.all(queues.values());
}
