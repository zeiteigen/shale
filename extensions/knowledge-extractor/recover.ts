import type { ShaleSDK } from '@shale/sdk';
import { acquireTaskLease } from '../../lib/task-lease';
import { commitExtractions } from './commit';

export async function run(sdk: ShaleSDK) {
  const lease=acquireTaskLease(sdk.database,sdk.extensionId,'knowledge-extractor-lease');
  if (!lease) return {committed:0,busy:true};
  try {return {committed:commitExtractions(sdk)};} finally {lease.release();}
}
export default run;
