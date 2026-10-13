import { resolve } from 'node:path';
import { getSDK } from '../sdk';
import { run } from '../extensions/knowledge-extractor';

/** Run one bounded extraction pass over specific live sources, using the normal lease and checkpoints. */
const sourceIds = process.argv.slice(2);
if (!sourceIds.length) throw new Error('Usage: bun scripts/digest-sources.ts <source-id> [source-id ...]');
const sdk = getSDK(resolve(import.meta.dir, '../extensions/knowledge-extractor'));
for (const id of sourceIds) {
  if (!sdk.database.query('SELECT 1 FROM sources WHERE id=?').get(id)) throw new Error(`Unknown live source ${id}`);
}
const result = await run(sdk, { sourceIds });
console.log(JSON.stringify(result));
if ('busy' in result && result.busy) process.exitCode = 2;
else if ('rejected' in result && result.rejected) process.exitCode = 1;
