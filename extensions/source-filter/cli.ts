import type { RunOptions } from './types';

export function parseArguments(args: readonly string[]): RunOptions {
  const options: RunOptions = {}, ids: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--source' && args[index + 1] && !args[index + 1]!.startsWith('--')) ids.push(args[++index]!);
    else throw new Error(`Unknown or incomplete argument: ${arg}. Use --dry-run and/or --source ID.`);
  }
  if (ids.length) options.sourceIds = ids;
  return options;
}
