import type { Source } from '../../lib/db';
import type { SourceMemoryRecord } from '../../lib/memory/types';

export type FilterCategory = 'useful' | 'capture_failure' | 'spam' | 'boilerplate' | 'unknown';
export interface FilterVerdict {
  decision: 'keep' | 'remove' | 'review';
  category: FilterCategory;
  method: 'algorithm' | 'llm';
  confidence: number;
  reason: string;
  signals: string[];
  quotations: string[];
}
export interface FilterSource extends Source {
  contentKey: string;
  version: number;
  memory: SourceMemoryRecord | null;
}
export interface StoredDecision {
  sourceId: string;
  contentKey: string;
  policyKey: string;
  sourceVersion: number;
  verdict: FilterVerdict;
  attempts: number;
  retryAt: number;
  appliedAt: number | null;
}
export interface RunOptions { dryRun?: boolean; sourceIds?: readonly string[] }
export interface FilterStats {
  scanned: number; protected: number; kept: number; proposed: number;
  algorithmicRemoved: number; llmRemoved: number; blocked: number;
  llmCalls: number; pending: number; failed: number; stale: number; busy: boolean;
}

export function keep(reason: string): FilterVerdict {
  return { decision: 'keep', category: 'useful', method: 'algorithm', confidence: 1,
    reason, signals: [], quotations: [] };
}
