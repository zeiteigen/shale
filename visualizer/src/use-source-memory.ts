import { useEffect, useState } from 'react';
import { request } from './api';
import type { GraphNode, SourceMemory } from './types';

/** Load complete retained memory only for the entry being read. */
export function useSourceMemory(node: GraphNode) {
  const [memory, setMemory] = useState<SourceMemory | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setMemory(null); setError(''); setLoading(Boolean(node.sourceId));
    if (node.sourceId) {
      request<SourceMemory>(`/api/knowledge/memory?sourceId=${encodeURIComponent(node.sourceId)}`, { signal: controller.signal })
        .then(result => { if (!controller.signal.aborted) setMemory(result); })
        .catch(reason => { if (!controller.signal.aborted) setError(reason.message); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }
    return () => controller.abort();
  }, [node.sourceId, node.chunks]);
  return { memory, error, loading };
}
