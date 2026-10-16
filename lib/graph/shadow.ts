import type { Database } from 'bun:sqlite';
import { ensureStorySchema } from './story-schema';

/**
 * Deterministic components run beside the model before they replace it. Each records its verdict here,
 * and the model's when one exists, so `scripts/llm-replacement-eval.ts` can measure agreement per kind.
 * Operational state: restricted profiles never see this table.
 */
export type ShadowKind = 'identity' | 'episode' | 'extraction' | 'template' | 'access' | 'summary' | 'relation';

export function recordShadow(db: Database, input: { kind: ShadowKind; subject: string; method: string; verdict: unknown; llm?: unknown }) {
  ensureStorySchema(db);
  db.query(`INSERT INTO graph_shadow_decisions(kind,subject_key,method,verdict_json,llm_verdict_json,at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(kind,subject_key,method) DO UPDATE SET verdict_json=excluded.verdict_json,
      llm_verdict_json=coalesce(excluded.llm_verdict_json,graph_shadow_decisions.llm_verdict_json),at=excluded.at`)
    .run(input.kind, input.subject, input.method, JSON.stringify(input.verdict ?? null),
      input.llm === undefined ? null : JSON.stringify(input.llm), Date.now());
}

/** Attach the model's verdict to an existing shadow row (the model may answer after the deterministic pass). */
export function recordShadowLLM(db: Database, kind: ShadowKind, subject: string, llm: unknown) {
  ensureStorySchema(db);
  db.query('UPDATE graph_shadow_decisions SET llm_verdict_json=? WHERE kind=? AND subject_key=?').run(JSON.stringify(llm), kind, subject);
}

/** Whether a deterministic component is promoted from shadow to acting (settings decide, read fresh by callers). */
export type ShadowMode = 'off' | 'shadow' | 'active';
export const shadowMode = (value: unknown): ShadowMode => value === 'off' || value === 'active' ? value : 'shadow';
