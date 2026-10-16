import type { Database } from "bun:sqlite";
import { TIERS } from "../../lib/access/policy";
import { LIVE_SOURCE_CONTENT_HASH_SQL } from "../../lib/access/source-hash";
import { predict, train, type SoftmaxModel } from "../../lib/text/softmax";
import { contentWords, fnv1a32 } from "../../lib/text/tokenize";

/**
 * A local stand-in for the LLM sensitivity pass, distilled from the LLM's own labels.
 *
 * Privacy errors are asymmetric: showing a private record to an agent is worse than hiding a personal one.
 * So the model never lowers anything. An item is "settled" only when the model predicts at least the
 * heuristic tier and the probability that the LLM would have gone *higher* than what we record is at most
 * a per-kind tail bound ε, chosen on held-out labels so that under-classification stays below `TARGET_UNDER`.
 * A source skips the LLM only when it and every listed entity and claim are settled.
 */
export type ItemKind = "source" | "entity" | "claim";
export const KINDS: readonly ItemKind[] = ["source", "entity", "claim"];
export const MODEL_VERSION = 1;
/** Highest tolerated rate of "LLM would have been more sensitive" among held-out items the model settles. */
export const TARGET_UNDER = 0.02;
const EPSILONS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.03, 0.05];
const MIN_CALIBRATION = 30;
const MAX_SOURCE_TOKENS = 600;

export interface ItemInput {
  kind: ItemKind;
  text: string;
  type?: string;
  uri?: string;
  predicate?: string;
  /** Origins of the sources the record appears in (a source's own origin). */
  origins: string[];
  heuristic: number;
  hard: boolean;
}

export interface LabeledItem extends ItemInput {
  id: string;
  label: number;
  /** A source the record appears in: calibration holds out whole sources, since records of one source correlate. */
  group?: string;
}

export interface KindModel {
  model: SoftmaxModel;
  /** Tail bound: settle only when P(LLM tier > recorded tier) ≤ epsilon; 0 disables settling. */
  epsilon: number;
  calibration: { items: number; settled: number; under: number; accuracy: number };
}

export interface DistilledModel {
  version: number;
  trainedAt: number;
  /** LLM labels available when trained; a refit is due when this grows. */
  labels: number;
  kinds: Partial<Record<ItemKind, KindModel>>;
}

const norm = (value: string) => value.toLocaleLowerCase().replace(/[\s_-]+/g, "");

/** Sparse features: words, record type, predicate, origins, URI host, and the heuristic verdict with crosses. */
export function itemFeatures(item: ItemInput): string[] {
  const features = new Set<string>();
  let tokens = contentWords(item.text);
  if (item.kind === "source") tokens = tokens.slice(0, MAX_SOURCE_TOKENS * 4);
  for (const token of tokens) {
    if (features.size >= MAX_SOURCE_TOKENS) break;
    features.add(`w:${token.length > 30 ? token.slice(0, 30) : token}`);
    // Digit shapes (account numbers, phone numbers) generalise better than the digits themselves.
    if (/\d/.test(token)) features.add(`d:${token.replace(/\d/g, "9").slice(0, 20)}`);
  }
  const type = item.type ? norm(item.type) : "";
  if (type) features.add(`t:${type}`);
  if (item.predicate) features.add(`p:${norm(item.predicate)}`);
  const host = item.uri?.match(/^[a-z][\w+.-]*:\/\/(?:www\.)?([^/:?#]+)/i)?.[1]?.toLocaleLowerCase();
  if (host) features.add(`u:${host}`);
  if (item.uri) features.add(`s:${item.uri.split(":")[0]!.toLocaleLowerCase()}`);
  for (const origin of new Set(item.origins)) {
    features.add(`o:${origin}`);
    if (type) features.add(`o:${origin}|t:${type}`);
  }
  if (!item.origins.length) features.add("o:none");
  features.add(`h:${item.heuristic}`);
  if (item.hard) features.add(`hh:${item.heuristic}`);
  if (type) features.add(`h:${item.heuristic}|t:${type}`);
  return [...features];
}

export interface Decision {
  /** Most likely LLM tier. */
  predicted: number;
  /** Tier to record: never below the heuristic (or an existing automatic label). */
  tier: number;
  /** P(LLM tier > tier). */
  tail: number;
  settled: boolean;
  probabilities: number[];
}

/** Decide one item. `floor` is the heuristic tier, or a higher tier the record already has. */
export function decide(kind: KindModel, item: ItemInput, floor = item.heuristic): Decision {
  const probabilities = predict(kind.model, itemFeatures(item));
  const predicted = probabilities.indexOf(Math.max(...probabilities));
  const tier = Math.max(floor, item.heuristic, predicted);
  const tail = probabilities.slice(tier + 1).reduce((a, b) => a + b, 0);
  // The model must itself agree with (or exceed) the heuristic: if it expects the LLM to lower the tier,
  // that judgment belongs to the LLM.
  const settled = kind.epsilon > 0 && predicted >= item.heuristic && tail <= kind.epsilon;
  return { predicted, tier, tail, settled, probabilities };
}

const heldOut = (item: LabeledItem) => fnv1a32(`calibration:${item.group ?? item.id}`) % 5 === 0;

function trainKind(items: LabeledItem[], seed: number) {
  return train(items.map(item => ({ features: itemFeatures(item), label: item.label })),
    { classes: TIERS.length, seed, epochs: 6, rate: 0.2, l2: 1e-4, minCount: 2 });
}

/** Calibrate ε on a held-out fifth, then fit the stored model on everything. */
export function fitKind(items: LabeledItem[], seed = 1): KindModel {
  const training = items.filter(item => !heldOut(item)), calibration = items.filter(item => heldOut(item));
  const probe = { model: trainKind(training, seed), epsilon: 1, calibration: { items: 0, settled: 0, under: 0, accuracy: 0 } };
  const decisions = calibration.map(item => ({ item, decision: decide(probe, item) }));
  let epsilon = 0, settled = 0, under = 0;
  // The largest bound whose held-out settled set is big enough to trust and misses at most TARGET_UNDER.
  if (calibration.length >= MIN_CALIBRATION) for (const candidate of EPSILONS) {
    const chosen = decisions.filter(({ item, decision }) => decision.predicted >= item.heuristic && decision.tail <= candidate);
    const missed = chosen.filter(({ item, decision }) => item.label > decision.tier).length;
    if (chosen.length >= MIN_CALIBRATION && missed / chosen.length <= TARGET_UNDER) { epsilon = candidate; settled = chosen.length; under = missed; }
  }
  const accuracy = decisions.length ? decisions.filter(({ item, decision }) => decision.predicted === item.label).length / decisions.length : 0;
  return { model: trainKind(items, seed), epsilon, calibration: { items: calibration.length, settled, under, accuracy } };
}

export function fitModel(items: LabeledItem[], labels = items.length): DistilledModel {
  const kinds: DistilledModel["kinds"] = {};
  for (const kind of KINDS) {
    const subset = items.filter(item => item.kind === kind);
    if (subset.length >= MIN_CALIBRATION * 5) kinds[kind] = fitKind(subset);
  }
  return { version: MODEL_VERSION, trainedAt: Date.now(), labels, kinds };
}

/** Source text as the LLM sees it: chunks in order, truncated. */
export function sourceText(db: Database, sourceId: string, maxChars: number) {
  let text = "";
  // A truncated iterator must not leave a cached statement active for the next source.
  const statement = db.prepare<{ text_content: string }, [string]>("SELECT text_content FROM chunks WHERE source_id=? ORDER BY chunk_index");
  try {
    for (const chunk of statement.iterate(sourceId)) {
      text += `${chunk.text_content}\n`;
      if (text.length >= maxChars) break;
    }
  } finally { statement.finalize(); }
  return text.slice(0, maxChars);
}

const split = (origins: string | null) => origins ? origins.split(",").filter(Boolean) : [];

/** Origins of the sources each entity appears in (mentions, chunk links, and claim evidence). */
export function entityOrigins(db: Database, ids?: number[]): Map<number, string[]> {
  return new Map([...entityLinks(db, ids)].map(([id, link]) => [id, link.origins]));
}

function entityLinks(db: Database, ids?: number[]): Map<number, { origins: string[]; first: string }> {
  const only = ids ? JSON.stringify(ids) : null;
  const filter = (column: string) => only ? ` WHERE ${column} IN (SELECT value FROM json_each($ids))` : "";
  const rows = db.query<{ id: number; origins: string | null; first: string }, Record<string, string>>(`SELECT x.entity_id AS id,group_concat(DISTINCT s.origin) AS origins,min(s.id) AS first FROM (
      SELECT entity_id,source_id FROM source_entities${filter("entity_id")}
      UNION SELECT ce.entity_id,c.source_id FROM chunk_entities ce JOIN chunks c ON c.id=ce.chunk_id${filter("ce.entity_id")}
      UNION SELECT cl.subject_id,r.source_id FROM graph_claims cl JOIN graph_evidence ev ON ev.claim_id=cl.id
        JOIN graph_source_revisions r ON r.id=ev.revision_id${filter("cl.subject_id")}
      UNION SELECT cl.object_id,r.source_id FROM graph_claims cl JOIN graph_evidence ev ON ev.claim_id=cl.id
        JOIN graph_source_revisions r ON r.id=ev.revision_id${filter("cl.object_id")}
    ) x JOIN sources s ON s.id=x.source_id GROUP BY x.entity_id`).all(only ? { $ids: only } : {});
  return new Map(rows.map(row => [row.id, { origins: split(row.origins), first: row.first }]));
}

export function claimOrigins(db: Database, ids?: string[]): Map<string, string[]> {
  return new Map([...claimLinks(db, ids)].map(([id, link]) => [id, link.origins]));
}

function claimLinks(db: Database, ids?: string[]): Map<string, { origins: string[]; first: string }> {
  const only = ids ? JSON.stringify(ids) : null;
  const rows = db.query<{ id: string; origins: string | null; first: string }, Record<string, string>>(`SELECT ev.claim_id AS id,group_concat(DISTINCT s.origin) AS origins,min(s.id) AS first
    FROM graph_evidence ev JOIN graph_source_revisions r ON r.id=ev.revision_id JOIN sources s ON s.id=r.source_id
    ${only ? "WHERE ev.claim_id IN (SELECT value FROM json_each($ids))" : ""} GROUP BY ev.claim_id`).all(only ? { $ids: only } : {});
  return new Map(rows.map(row => [row.id, { origins: split(row.origins), first: row.first }]));
}

export const claimText = (claim: { subject: string; predicate: string; object: string | null; value_json: string | null }) =>
  `${claim.subject} ${claim.predicate} ${claim.object ?? (claim.value_json ?? "").slice(0, 300)}`;

const HEURISTIC = (kind: string, id: string, hash: string) => `LEFT JOIN graph_access_labels h ON h.kind='${kind}' AND h.record_id=${id}
  AND h.origin='heuristic' AND h.content_hash=${hash}`;

/** Every current LLM label with the inputs the model sees at prediction time. */
export function trainingItems(db: Database, options: { maxChars?: number } = {}): LabeledItem[] {
  const items: LabeledItem[] = [];
  const maxChars = options.maxChars ?? 8000;
  for (const s of db.query<{ id: string; title: string; uri: string; origin: string; type: string; label: number; heuristic: number | null; hard: number | null }, []>(
    `SELECT s.id,s.title,s.uri,s.origin,s.type,l.tier AS label,h.tier AS heuristic,h.hard FROM sources s
      JOIN graph_access_labels l ON l.kind='source' AND l.record_id=s.id AND l.origin='llm' AND l.content_hash=${LIVE_SOURCE_CONTENT_HASH_SQL}
      ${HEURISTIC("source", "s.id", LIVE_SOURCE_CONTENT_HASH_SQL)}`).all())
    items.push({ kind: "source", id: s.id, group: s.id, label: s.label, text: `${s.title}\n${sourceText(db, s.id, maxChars)}`, type: s.type, uri: s.uri,
      origins: [s.origin], heuristic: s.heuristic ?? 0, hard: s.hard === 1 });
  const entityLink = entityLinks(db);
  for (const e of db.query<{ id: number; name: string; type: string; label: number; heuristic: number | null; hard: number | null }, []>(
    `SELECT e.id,coalesce(e.display_name,e.name) AS name,e.type,l.tier AS label,h.tier AS heuristic,h.hard FROM graph_access_labels l
      JOIN entities e ON e.id=CAST(l.record_id AS INTEGER) AND l.content_hash=coalesce(e.display_name,e.name)||char(31)||e.type
      ${HEURISTIC("entity", "l.record_id", "l.content_hash")} WHERE l.kind='entity' AND l.origin='llm'`).all())
    items.push({ kind: "entity", id: String(e.id), group: entityLink.get(e.id)?.first, label: e.label, text: e.name, type: e.type,
      origins: entityLink.get(e.id)?.origins ?? [],
      heuristic: e.heuristic ?? 0, hard: e.hard === 1 });
  const claimLink = claimLinks(db);
  for (const c of db.query<{ id: string; subject: string; predicate: string; object: string | null; value_json: string | null; label: number; heuristic: number | null; hard: number | null }, []>(
    `SELECT c.id,coalesce(s.display_name,s.name) AS subject,c.predicate,coalesce(o.display_name,o.name) AS object,c.value_json,
      l.tier AS label,h.tier AS heuristic,h.hard FROM graph_access_labels l JOIN graph_claims c ON c.id=l.record_id
      JOIN entities s ON s.id=c.subject_id LEFT JOIN entities o ON o.id=c.object_id
      ${HEURISTIC("claim", "l.record_id", "''")} WHERE l.kind='claim' AND l.origin='llm'`).all())
    items.push({ kind: "claim", id: c.id, group: claimLink.get(c.id)?.first, label: c.label, text: claimText(c), predicate: c.predicate,
      origins: claimLink.get(c.id)?.origins ?? [],
      heuristic: c.heuristic ?? 0, hard: c.hard === 1 });
  return items;
}

export const countLLMLabels = (db: Database) =>
  db.query<{ n: number }, []>("SELECT count(*) AS n FROM graph_access_labels WHERE origin='llm'").get()!.n;

/** Parse a stored model; anything from another version is ignored and refit. */
export function parseModel(raw: string | null): DistilledModel | null {
  if (!raw) return null;
  try {
    const model = JSON.parse(raw) as DistilledModel;
    return model?.version === MODEL_VERSION && model.kinds ? model : null;
  } catch { return null; }
}

/** Refit when labels grew by a tenth (at least 100) or the model is a week old and labels changed. */
export function isStale(model: DistilledModel | null, labels: number, now = Date.now()) {
  if (!model) return true;
  const grown = labels - model.labels;
  return grown >= Math.max(100, model.labels * 0.1) || (grown !== 0 && now - model.trainedAt > 7 * 86_400_000);
}
