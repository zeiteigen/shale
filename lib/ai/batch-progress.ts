import type { ModelRole } from "./config";
import { boundedMap } from "./bounded-map";

let nextBatchId = 0;

/** Report status changes immediately, and request counts at most once per second. */
export function batchProgress(role: ModelRole, total: number, id = `local-${++nextBatchId}`) {
  const started = performance.now();
  let lastStatus = "";
  let lastCounts = "";
  let lastReported = -Infinity;
  return (status: string, completed = 0, failed = 0) => {
    const now = performance.now();
    const counts = `${completed}:${failed}:${total}`;
    if (status === lastStatus &&
      (counts === lastCounts || now - lastReported < 1000)) return;
    lastStatus = status;
    lastCounts = counts;
    lastReported = now;
    const percent = total ? Math.floor((completed + failed) / total * 100) : 0;
    console.log(`[batch:${role}] ${id} ${status}: ${completed}/${total} completed, ${failed} failed (${percent}%) | ${((now - started) / 1000).toFixed(1)}s elapsed`);
  };
}

/** Track actual completed requests while preserving boundedMap's failure draining. */
export async function mapWithBatchProgress<T, R>(
  role: ModelRole, items: readonly T[], concurrency: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!items.length) return [];
  // Individual synchronous calls do not need batch output.
  if (items.length === 1) return boundedMap(items, concurrency, work);
  const report = batchProgress(role, items.length);
  let completed = 0;
  let failed = 0;
  report("running");
  try {
    const results = await boundedMap(items, concurrency, async (item, index) => {
      try {
        const result = await work(item, index);
        completed++;
        report("running", completed, failed);
        return result;
      } catch (error) {
        failed++;
        report("running", completed, failed);
        throw error;
      }
    });
    report("completed", completed, failed);
    return results;
  } catch (error) {
    report("interrupted", completed, failed);
    throw error;
  }
}
