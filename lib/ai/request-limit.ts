interface Waiting { limit: number; start(): void }
interface Pool { active: number; waiting: Waiting[] }
const pools = new Map<string, Pool>();

/** Bound actual network calls across SDK instances and nested preparation batches. */
export async function limitModelRequest<T>(key: string, limit: number, work: () => Promise<T>): Promise<T> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Model concurrency must be a positive integer");
  let pool = pools.get(key);
  if (!pool) { pool = { active: 0, waiting: [] }; pools.set(key, pool); }
  const current = pool;
  const pump = () => {
    while (current.waiting.length && current.active < current.waiting[0].limit) {
      current.active++;
      current.waiting.shift()!.start();
    }
  };
  await new Promise<void>(start => { current.waiting.push({ limit, start }); pump(); });
  try { return await work(); }
  finally {
    current.active--;
    pump();
    if (!current.active && !current.waiting.length) pools.delete(key);
  }
}
