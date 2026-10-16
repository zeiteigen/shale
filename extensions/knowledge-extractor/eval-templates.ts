/**
 * Offline evaluation of the email template tier (P2). The production database is opened read-only and copied into
 * memory; induction, labels, and template digests happen only in that copy.
 *
 *   bun extensions/knowledge-extractor/eval-templates.ts [data/production.db] [--no-llm] [--label-limit N] [--min-alignment 0.8]
 *     [--label-cache path.json]
 *
 * - templates: clusters, active (usable) wrappers, and their verdicts.
 * - coverage: share of email sources (all, and the undigested backlog) whose every message aligns with a template, and
 *   the share a template digest would actually replace in active mode (= model calls avoided).
 * - agreement: on already-digested email that a template would digest, template digest vs the model's stored digest:
 *   entity-name overlap and involvement. Field agreement per source = mean(involvement agrees, entity precision).
 * Slot labels come from the configured local model (OPENAI_BASE_URL in resources/settings.json) when it answers;
 * otherwise (or with --no-llm) from heuristic slot typing (lib/graph/mention-typing.ts), which the report states.
 */
import { Database } from 'bun:sqlite';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ShaleSDK } from '@shale/sdk';
import { applyWrapper, type Wrapper } from '../../lib/graph/templates';
import { typeMention } from '../../lib/graph/mention-typing';
import { ensureTemplateTables, induceTemplates, labelPrompt, parseTemplateLabels, templateExtraction, type TemplateLabels, type TemplateRow } from './templates';

const args = process.argv.slice(2);
const flag = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args.splice(index, 2)[1] : undefined; };
const noLlm = args.includes('--no-llm');
const labelLimit = Number(flag('--label-limit') ?? Infinity);
const minAlignment = Number(flag('--min-alignment') ?? 0.8);
const cachePath = flag('--label-cache');
const path = resolve(args.find(arg => !arg.startsWith('--')) ?? 'data/production.db');
const pct = (n: number, d: number) => d ? `${(100 * n / d).toFixed(1)}% (${n}/${d})` : 'n/a';

const production = new Database(path, { readonly: true });
const image = production.serialize();
// A WAL-mode header cannot be opened in memory: mark the copy as a rollback-journal database.
image[18] = 1; image[19] = 1;
const db = Database.deserialize(image);
production.close();

const settings = (() => { try { return JSON.parse(readFileSync(resolve(import.meta.dir, '../../resources/settings.json'), 'utf8')) as Record<string, string>; } catch { return {}; } })();
const base = settings.OPENAI_BASE_URL, model = settings.OPENAI_CHAT_MODEL;
async function reachable() {
  if (noLlm || !base || !/^https?:\/\/(?:localhost|127\.0\.0\.1)/.test(base)) return false;
  try { return (await fetch(`${base}/models`, { signal: AbortSignal.timeout(3000) })).ok; } catch { return false; }
}
const useLlm = await reachable();
async function queryLLM(prompt: string) {
  const response = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 2048, reasoning_effort: 'none',
      response_format: { type: 'json_object' } }) });
  if (!response.ok) throw new Error(`model HTTP ${response.status}`);
  return (await response.json() as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content;
}

// ---- induction (in the in-memory copy)
let started = performance.now();
const induction = induceTemplates(db, { minMembers: 5, minAlignment, maxInductions: 10_000 });
const inductionMs = performance.now() - started;
const templates = db.query<TemplateRow, []>("SELECT * FROM graph_email_templates WHERE status='active' ORDER BY covered_count DESC").all();

/** Heuristic labels: entity slots typed by form; verdict boilerplate unless a slot names a person or opportunity. */
function heuristicLabels(template: TemplateRow, wrapper: Wrapper): TemplateLabels {
  const examples = db.query<{ text: string }, [string]>(`SELECT json_extract(m.payload,'$.text') AS text FROM graph_email_template_members t
    JOIN email_messages m USING(conversation_id,message_id) WHERE t.template_id=? LIMIT 3`).all(template.template_id)
    .map(row => applyWrapper(wrapper, row.text)?.slots ?? []);
  const slots: TemplateLabels['slots'] = [];
  for (let slot = 1; slot <= wrapper.slots; slot++) {
    const values = examples.map(example => example.find(item => item.slot === slot)).filter(item => item && item.lines === undefined).map(item => item!.value);
    const types = values.map(value => typeMention(value.replace(/[.,:;!?]+$/, '')) ?? (/^\p{Lu}[\p{L}'’-]+(?: \p{Lu}[\p{L}'’.-]*){1,2}$/u.test(value.trim()) ? 'Person' : null));
    const type = types[0];
    slots.push(type && types.every(item => item === type) ? { slot, kind: 'entity', type } : { slot, kind: 'ignore' });
  }
  const informative = slots.some(slot => slot.type === 'Person' || slot.type === 'Opportunity' || slot.type === 'Event');
  return { verdict: informative ? 'informative' : 'boilerplate', involvement: 'observer', slots, entities: [], claims: [], summary: '', activity: null };
}

const cache: Record<string, TemplateLabels | { error: string }> = cachePath && existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {};
started = performance.now();
let labelled = 0, labelErrors = 0, modelCalls = 0;
for (const [index, template] of templates.entries()) {
  if (index >= labelLimit) break;
  const wrapper = JSON.parse(template.wrapper) as Wrapper;
  const key = `${template.template_id}:${template.wrapper_hash}`;
  let labels: TemplateLabels | null = null;
  if (useLlm) {
    const cached = cache[key];
    if (cached && !('error' in cached)) labels = cached;
    else {
      const examples = db.query<{ text: string }, [string]>(`SELECT json_extract(m.payload,'$.text') AS text FROM graph_email_template_members t
        JOIN email_messages m USING(conversation_id,message_id) WHERE t.template_id=? ORDER BY m.sent_at`).all(template.template_id);
      const picks = examples.length <= 3 ? examples : [0, Math.floor(examples.length / 2), examples.length - 1].map(i => examples[i]!);
      try {
        modelCalls++;
        labels = parseTemplateLabels(await queryLLM(labelPrompt(template, wrapper, picks.map(row => applyWrapper(wrapper, row.text)?.slots ?? []))), wrapper);
        cache[key] = labels;
      } catch (error) { labelErrors++; cache[key] = { error: String(error) }; }
    }
  } else labels = heuristicLabels(template, wrapper);
  if (!labels) continue;
  labelled++;
  db.query('UPDATE graph_email_templates SET slot_labels=?,verdict=? WHERE template_id=?').run(JSON.stringify(labels), labels.verdict, template.template_id);
}
if (cachePath) writeFileSync(cachePath, JSON.stringify(cache, null, 1));
const labelMs = performance.now() - started;

// ---- coverage
interface Source { source_id: string; id: number; title: string; type: string; uri: string; origin: string; created_at: number; updated_at: number; digested: number }
const sources = db.query<Source, []>(`SELECT r.source_id,r.id,r.title,s.type,s.uri,s.origin,s.created_at,s.updated_at,
    EXISTS(SELECT 1 FROM graph_source_digests d WHERE d.source_id=s.id) AS digested
  FROM graph_source_revisions r JOIN sources s ON s.id=r.source_id AND s.hash=r.hash WHERE s.origin='email'`).all();
const sdk = { database: db } as unknown as ShaleSDK;
const verdictOf = new Map(db.query<{ template_id: string; verdict: string }, []>('SELECT template_id,verdict FROM graph_email_templates').all().map(row => [row.template_id, row.verdict]));
const outcomes = sources.map(source => ({ source, outcome: templateExtraction(sdk, source, { minAlignment }) }));
// Structural coverage: every message aligns with an active template (labelled or not).
ensureTemplateTables(db);
const aligned = (source: Source) => {
  const rows = db.query<{ ok: number }, [number, string]>(`SELECT tm.template_id IS NOT NULL AS ok FROM email_windows w
    JOIN email_messages m ON m.conversation_id=w.conversation_id AND m.sent_at BETWEEN w.start_time AND w.end_time
    LEFT JOIN graph_email_template_members tm ON tm.conversation_id=m.conversation_id AND tm.message_id=m.message_id AND tm.score>=?
    WHERE w.source_id=?`).all(minAlignment, source.source_id);
  return rows.length > 0 && rows.every(row => row.ok);
};
const groups = { all: outcomes, undigested: outcomes.filter(item => !item.source.digested) };
const coverage = Object.fromEntries(Object.entries(groups).map(([name, items]) => {
  const matched = items.filter(item => item.outcome.kind === 'match');
  const reasons: Record<string, number> = {};
  for (const item of items) if (item.outcome.kind === 'miss') reasons[item.outcome.reason] = (reasons[item.outcome.reason] ?? 0) + 1;
  return [name, { sources: items.length, aligned: pct(items.filter(item => aligned(item.source)).length, items.length),
    llmCallsAvoided: pct(matched.length, items.length),
    informative: matched.filter(item => item.outcome.kind === 'match' && item.outcome.verdict === 'informative').length,
    boilerplate: matched.filter(item => item.outcome.kind === 'match' && item.outcome.verdict === 'boilerplate').length, misses: reasons }];
}));

// ---- agreement with the model's stored digests
const parent = new Map(db.query<{ id: number; canonical_id: number }, []>('SELECT id,canonical_id FROM entities WHERE canonical_id IS NOT NULL').all().map(row => [row.id, row.canonical_id]));
const canonical = (id: number) => { let current = id; for (let i = 0; i < 32 && parent.has(current); i++) current = parent.get(current)!; return current; };
const self = db.query<{ id: number }, []>("SELECT id FROM entities WHERE stable_id='self'").get()?.id;
const nameOf = db.query<{ name: string; type: string }, [number]>('SELECT coalesce(display_name,name) AS name,type FROM entities WHERE id=?');
const norm = (name: string) => name.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const same = (a: string, b: string) => a === b || (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a)));
const MODEL_TYPES = new Set(['Person', 'Organization', 'Project', 'Opportunity', 'Event', 'Artifact', 'Product', 'Place', 'Course']);
const involvementClass = (value: string | null | undefined) => value === 'author' || value === 'participant' ? 'participant' : 'observer';
const informativeRows: Array<{ precision: number | null; recall: number | null; involvement: boolean; field: number; templateId: string }> = [];
const boilerplateRows: Array<{ llmEntities: number; llmInvolvement: string; summary: string }> = [];
for (const { source, outcome } of outcomes) {
  if (!source.digested || outcome.kind !== 'match') continue;
  const digest = db.query<{ entity_ids: string; involvement: string; summary: string }, [string]>('SELECT entity_ids,involvement,summary FROM graph_source_digests WHERE source_id=?').get(source.source_id)!;
  const llm = [...new Set((JSON.parse(digest.entity_ids) as number[]).map(canonical))].filter(id => id !== (self === undefined ? -1 : canonical(self)))
    .map(id => nameOf.get(id)).filter((row): row is { name: string; type: string } => !!row && MODEL_TYPES.has(row.type)).map(row => norm(row.name));
  if (outcome.verdict === 'boilerplate') { boilerplateRows.push({ llmEntities: llm.length, llmInvolvement: digest.involvement, summary: digest.summary.slice(0, 120) }); continue; }
  const mine = outcome.extraction.entities.filter(entity => entity.entityId === undefined).map(entity => norm(entity.name));
  const precision = mine.length ? mine.filter(name => llm.some(other => same(name, other))).length / mine.length : null;
  const recall = llm.length ? llm.filter(name => mine.some(other => same(name, other))).length / llm.length : null;
  const involvement = involvementClass(outcome.extraction.involvement) === involvementClass(digest.involvement);
  informativeRows.push({ precision, recall, involvement, field: ((involvement ? 1 : 0) + (precision ?? 1)) / 2, templateId: outcome.templateIds[0]! });
}
const mean = (values: number[]) => values.length ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(3)) : null;
const agreement = {
  informativeDigested: informativeRows.length,
  entityPrecision: mean(informativeRows.flatMap(row => row.precision === null ? [] : [row.precision])),
  entityRecall: mean(informativeRows.flatMap(row => row.recall === null ? [] : [row.recall])),
  involvementAgreement: mean(informativeRows.map(row => row.involvement ? 1 : 0)),
  fieldAgreement: mean(informativeRows.map(row => row.field)),
  gate: '≥ 0.9 field agreement',
  boilerplateDigested: boilerplateRows.length,
  boilerplateModelEntitiesMean: mean(boilerplateRows.map(row => row.llmEntities)),
  boilerplateModelObserverShare: mean(boilerplateRows.map(row => involvementClass(row.llmInvolvement) === 'observer' ? 1 : 0)),
};
const perTemplate = [...Map.groupBy(informativeRows, row => row.templateId)].map(([id, rows]) => ({ id, sources: rows.length, field: mean(rows.map(row => row.field)),
  precision: mean(rows.flatMap(row => row.precision === null ? [] : [row.precision])), involvement: mean(rows.map(row => row.involvement ? 1 : 0)) }))
  .sort((a, b) => b.sources - a.sources).slice(0, 15);

const verdicts: Record<string, number> = {};
for (const template of templates) { const verdict = verdictOf.get(template.template_id) ?? 'unlabelled'; verdicts[verdict] = (verdicts[verdict] ?? 0) + 1; }
console.log(JSON.stringify({
  labels: useLlm ? `local model ${model} at ${base} (${modelCalls} calls, ${labelErrors} invalid answers)` : 'HEURISTIC slot typing (model unreachable or --no-llm)',
  templates: { clusters: induction.clusters, active: templates.length, labelled, verdicts, inductionMs: Math.round(inductionMs), labelMs: Math.round(labelMs) },
  coverage, agreement, perTemplate,
  topTemplates: templates.slice(0, 20).map(template => ({ sender: template.sender, skeleton: template.skeleton, covered: template.covered_count,
    members: template.member_count, verdict: verdictOf.get(template.template_id) })),
}, null, 2));
