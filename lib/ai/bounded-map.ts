/** Preserve input order, stop scheduling on failure, and drain started work before rejecting. */
export async function boundedMap<T, R>(
  items: readonly T[], concurrency: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new Error("Batch concurrency must be a positive integer");
  const results = new Array<R>(items.length);
  let cursor = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (!failed && cursor < items.length) {
      const index = cursor++;
      try { results[index] = await work(items[index], index); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
    }
  }));
  if (failed) throw failure;
  return results;
}
