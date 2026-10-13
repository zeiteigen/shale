import { expect, it } from 'bun:test';
import type { CronExtension } from '../lib/extension';
import { runStartupJobs } from '../main/startup-crons';

it('starts independent extensions while preserving order and failure isolation within an extension', async () => {
  const cron = (name: string, extensionId: string, startup = true): CronExtension => ({
    name, extensionId, schedule: '* * * * *', script: `${name}.ts`, run_on_startup: startup,
  });
  let unblock!: () => void;
  const held = new Promise<void>(resolve => { unblock = resolve; });
  let ready!: () => void;
  const independentStarted = new Promise<void>(resolve => { ready = resolve; });
  const started: string[] = [], errors: string[] = [];
  const running = runStartupJobs([
    cron('import', 'email'), cron('sync', 'email'), cron('extract', 'knowledge-extractor'),
    cron('resolve', 'knowledge-graph'), cron('scheduled-only', 'other', false),
  ], async job => {
    started.push(job.name!);
    if (job.name === 'import') { await held; throw new Error('Import failed'); }
    if (job.name === 'resolve') ready();
  }, (job, error) => { errors.push(`${job.name}: ${(error as Error).message}`); });

  try {
    await independentStarted;
    expect(started).toEqual(['import', 'extract', 'resolve']);
  } finally { unblock(); }
  await running;
  expect(started).toEqual(['import', 'extract', 'resolve', 'sync']);
  expect(errors).toEqual(['import: Import failed']);
});
