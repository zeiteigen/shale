import { useCallback, useEffect, useState } from "react";
import { request } from "./api";

/** Poll serially and cancel on navigation so slow requests never accumulate. */
export function usePoll<T>(path: string, interval = 2000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await request<T>(path, { signal: controller.signal });
        if (!controller.signal.aborted) { setData(result); setError(null); }
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Connection failed.");
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, interval);
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [path, interval, revision]);
  return { data, error, refresh };
}
