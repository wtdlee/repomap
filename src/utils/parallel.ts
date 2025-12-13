/**
 * Parallel processing utilities
 */

/**
 * Process items in parallel with concurrency limit
 *
 * @param items - Items to process
 * @param fn - Async function to apply to each item
 * @param concurrency - Maximum concurrent operations (default: CPU cores)
 */
export async function parallelMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number = 8
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let currentIndex = 0;

  async function worker(): Promise<void> {
    while (currentIndex < items.length) {
      const index = currentIndex++;
      if (index < items.length) {
        results[index] = await fn(items[index], index);
      }
    }
  }

  // Create workers up to concurrency limit
  const workers = Array(Math.min(concurrency, items.length))
    .fill(null)
    .map(() => worker());

  await Promise.all(workers);
  return results;
}

/**
 * Process items in parallel, collecting successful results
 * Failed items are silently ignored
 */
export async function parallelMapSafe<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number = 8
): Promise<R[]> {
  const results: (R | null)[] = new Array(items.length).fill(null);
  let currentIndex = 0;

  async function worker(): Promise<void> {
    while (currentIndex < items.length) {
      const index = currentIndex++;
      if (index < items.length) {
        try {
          results[index] = await fn(items[index], index);
        } catch {
          // Silently ignore errors
          results[index] = null;
        }
      }
    }
  }

  const workers = Array(Math.min(concurrency, items.length))
    .fill(null)
    .map(() => worker());

  await Promise.all(workers);
  return results.filter((r): r is R => r !== null);
}

/**
 * Process items in batches
 */
export async function batchProcess<T, R>(
  items: T[],
  fn: (batch: T[]) => Promise<R[]>,
  batchSize: number = 50
): Promise<R[]> {
  const results: R[] = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await fn(batch);
    results.push(...batchResults);
  }

  return results;
}
