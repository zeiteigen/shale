import { fullNameKey } from './identity-keys';
import { extractiveSummary } from '../text/textrank';

/**
 * Deterministic episode narrative (plan P4.5): kind, stage, roles, closed status, title, summary, and steps
 * from the members' digests, without the model.
 *
 *   kind:    the members' own activity kinds (digest output) by vote, else lexicon cues;
 *   stage:   a per-kind finite-state machine over lexicon cues in titles, activity stages, and summaries.
 *            Stages only advance (a reminder after the interview does not rewind it); terminal states are
 *            outcomes, and the closing ones (rejected, withdrawn, delivered, refunded, completed, attended)
 *            close the episode when they are its latest cue;
 *   title:   the most specific (top idf × member share) entity the defining members share, plus a kind word, made unique
 *            among open episodes (mergeSameTitled folds same-titled episodes, so a collision would merge);
 *   summary: extractive LexRank over the member digest summaries (lib/text/textrank.ts).
 */
export type EpisodeKind = 'application' | 'purchase' | 'learning' | 'event' | 'research' | 'project' | 'admin' | 'other';
export type MemberRole = 'trigger' | 'progress' | 'outcome' | 'context';
interface Stage { name: string; cue: RegExp; terminal?: boolean; closes?: boolean }

/** Ordered stages per kind; a later stage outranks an earlier one. Terminal stages are alternatives of equal rank. */
export const STAGES: Partial<Record<EpisodeKind, Stage[]>> = {
  application: [
    { name: 'received', cue: /\b(application (received|submitted|confirm\w*)|thanks? (you )?for (your )?(applying|application)|received your application|applied|submitted)\b/ },
    { name: 'review', cue: /\b(under review|reviewing your application|missing documents?|documents? (required|requested)|additional information|status update|shortlist\w*|waitlist\w*|next steps)\b/ },
    { name: 'interview', cue: /\binterview\w*\b/ },
    { name: 'offer', cue: /\b(offer of admission|admission offer|offer letter|job offer|you('ve| have) been (admitted|accepted|selected)|admitted|congratulations|accepted)\b/, terminal: true },
    { name: 'rejected', cue: /\b(reject\w*|unsuccessful|regret to inform|not (been )?(selected|admitted|accepted)|unable to offer)\b/, terminal: true, closes: true },
    { name: 'withdrawn', cue: /\b(withdr[ae]w\w*|withdrawal)\b/, terminal: true, closes: true },
  ],
  purchase: [
    { name: 'order', cue: /\b(order (placed|confirm\w*|received|#)|your order|purchased?|receipt|payment (received|confirm\w*)|invoice)\b/ },
    { name: 'shipped', cue: /\b(shipped|on (its|the) way|dispatched|out for delivery|tracking number|in transit)\b/ },
    { name: 'delivered', cue: /\b(delivered|has arrived|picked up)\b/, terminal: true, closes: true },
    { name: 'refunded', cue: /\b(refund\w*|return (processed|received)|order cancel\w*)\b/, terminal: true, closes: true },
  ],
  learning: [
    { name: 'enrolled', cue: /\b(enrol\w*|registered for|welcome to (the )?(course|class|program)|course start\w*)\b/ },
    { name: 'in-progress', cue: /\b(lecture|lesson|assignment|revision|homework|quiz|module|chapter|week \d+|notes?)\b/ },
    { name: 'completed', cue: /\b(completed|course complete|certificate|finished the course|final (grade|result)s?)\b/, terminal: true, closes: true },
  ],
  event: [
    { name: 'invited', cue: /\b(invit\w*|save the date|rsvp|announc\w*|register now|call for)\b/ },
    { name: 'registered', cue: /\b(registration (confirmed|complete)|you('re| are) (registered|in|going)|ticket|confirmed your (spot|seat)|registered)\b/ },
    { name: 'attended', cue: /\b(attended|thanks? (you )?for (attending|joining|coming)|recording (is )?available|recap)\b/, terminal: true, closes: true },
  ],
};

/** Kind cues, used only when members carry no activity kind. */
const KIND_CUES: Array<[EpisodeKind, RegExp]> = [
  ['application', /\b(appl(y|ied|ication)|admission|interview|co-?op|internship|scholarship|candidate)\b/],
  ['purchase', /\b(order|purchase|receipt|shipping|delivery|refund|discount|checkout)\b/],
  ['event', /\b(event|webinar|conference|symposium|workshop|hackathon|rsvp|meetup)\b/],
  ['learning', /\b(course|lecture|revision|study|lesson|homework|syllabus|exam)\b/],
  ['research', /\b(research|paper|abstract|experiment|dataset)\b/],
  ['project', /\b(project|repo(sitory)?|build|prototype|deploy)\b/],
];
const KINDS = new Set<EpisodeKind>(['application', 'purchase', 'learning', 'event', 'research', 'project', 'admin', 'other']);
const KIND_WORD: Record<EpisodeKind, string> = {
  application: 'application', purchase: 'purchase', learning: 'studies', event: 'event', research: 'research', project: 'project', admin: 'admin', other: '',
};
/** Entity types that can name a pursuit; people and pages rarely do, and are used only when nothing else is shared. */
const NAMING_TYPES = ['Organization', 'Project', 'Course', 'Opportunity', 'Event', 'Product', 'Artifact', 'Concept', 'Person'];

export interface NarrativeMember {
  sourceId: string; title: string; summary: string; at: number | null; involvement: string | null;
  activity?: { label?: string; kind?: string; stage?: string } | null;
}
export interface NarrativeEntity { id: number; name: string; type: string; idf: number; support: number }

const text = (member: NarrativeMember, withSummary: boolean) =>
  `${member.activity?.stage ?? ''} ${member.title} ${withSummary ? member.summary.split(/(?<=[.!?])\s/)[0] ?? '' : ''}`.toLowerCase();

/** The kind: members' activity kinds by vote (ties to the earliest), else lexicon cues over titles and labels. */
export function episodeKind(members: NarrativeMember[], fallback?: string): EpisodeKind {
  const votes = new Map<EpisodeKind, number>();
  for (const member of members) {
    const kind = member.activity?.kind as EpisodeKind | undefined;
    if (kind && KINDS.has(kind)) votes.set(kind, (votes.get(kind) ?? 0) + 1);
  }
  if (votes.size) return [...votes].sort((a, b) => b[1] - a[1])[0]![0];
  if (fallback && KINDS.has(fallback as EpisodeKind) && fallback !== 'other') return fallback as EpisodeKind;
  const corpus = members.map(member => `${member.activity?.label ?? ''} ${member.title}`).join(' ').toLowerCase();
  let best: EpisodeKind = 'other', count = 0;
  for (const [kind, cue] of KIND_CUES) { const n = corpus.match(new RegExp(cue.source, 'g'))?.length ?? 0; if (n > count) { best = kind; count = n; } }
  return best;
}

/** The stage one member's text signals for a kind (terminal stages checked first: "rejected after interview"). */
export function memberStage(kind: EpisodeKind, member: NarrativeMember): { stage: Stage; rank: number } | null {
  const stages = STAGES[kind];
  if (!stages) return null;
  for (const withSummary of [false, true]) {
    const body = text(member, withSummary);
    const ranked = stages.map((stage, index) => ({ stage, rank: stage.terminal ? stages.findIndex(s => s.terminal) : index }));
    const hit = [...ranked.filter(r => r.stage.terminal), ...ranked.filter(r => !r.stage.terminal).reverse()].find(r => r.stage.cue.test(body));
    if (hit) return hit;
  }
  return null;
}

/**
 * Run the kind's state machine over members in time order. Returns each member's own stage, the episode's
 * stage (monotone: it never moves back), and whether the latest cue closes the episode.
 */
export function runStages(kind: EpisodeKind, members: NarrativeMember[]) {
  const ordered = [...members].sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  const own = new Map<string, Stage>();
  let state: { stage: Stage; rank: number } | null = null, last: Stage | null = null;
  for (const member of ordered) {
    const hit = memberStage(kind, member);
    // A later member without a cue still shows the story going on (a volunteer deadline after a rejection).
    last = hit?.stage ?? null;
    if (!hit) continue;
    own.set(member.sourceId, hit.stage);
    if (!state || hit.rank > state.rank || (hit.stage.terminal && hit.rank >= state.rank)) state = hit;
  }
  // Closed only when the closing cue comes from the latest member: anything after it means the story went on.
  const closed = Boolean(state?.stage.closes && last === state.stage);
  return { own, stage: state?.stage.name ?? null, closed };
}

/** A member's role: the first is the trigger, bystanders are context, terminal stages are outcomes. */
export function memberRole(kind: EpisodeKind, member: NarrativeMember, isFirst: boolean): MemberRole {
  if (isFirst) return 'trigger';
  if (member.involvement !== 'participant' && member.involvement !== 'author') return 'context';
  if (memberStage(kind, member)?.stage.terminal) return 'outcome';
  // The digest's own stage words for outcomes (kept from the earlier role() rule).
  return /offer|accept|reject|declin|complet|finish|result|decision|hired|admitted|interview/i.test(member.activity?.stage ?? '') ? 'outcome' : 'progress';
}

/**
 * Title from the most specific entity most defining members share: support ≥ 30% of them (at least one),
 * highest idf, preferring naming types in NAMING_TYPES order only on ties. Unique among `taken` title keys.
 */
export function episodeTitle(kind: EpisodeKind, entities: NarrativeEntity[], members: NarrativeMember[], taken: Set<string>, startedAt: number | null): string {
  const need = Math.max(1, Math.ceil(0.3 * members.length));
  const usable = entities.filter(entity => entity.support >= need && entity.idf > 0 && NAMING_TYPES.includes(entity.type)
    && !/^(https?:|entity:|#)/.test(entity.name) && !entity.name.includes('@'));
  const preferred = usable.filter(entity => entity.type !== 'Person');
  const pool = preferred.length ? preferred : usable;
  // Specific and shared: idf weighted by the share of members carrying it (the rarest one-off mention loses
  // to the organisation every member names).
  const score = (entity: NarrativeEntity) => entity.idf * Math.min(1, entity.support / Math.max(1, members.length));
  const best = pool.sort((a, b) => score(b) - score(a) || b.idf - a.idf || NAMING_TYPES.indexOf(a.type) - NAMING_TYPES.indexOf(b.type) || a.id - b.id)[0];
  let base: string;
  if (best) {
    const word = KIND_WORD[kind];
    base = word && !best.name.toLowerCase().includes(word.toLowerCase()) ? `${best.name} ${word}` : best.name;
  } else {
    const labels = new Map<string, number>();
    for (const member of members) if (member.activity?.label) labels.set(member.activity.label, (labels.get(member.activity.label) ?? 0) + 1);
    base = [...labels].sort((a, b) => b[1] - a[1])[0]?.[0] ?? members[0]?.title.split(' · ')[0] ?? 'Episode';
  }
  base = base.slice(0, 100);
  if (!taken.has(fullNameKey(base) ?? base)) return base;
  const month = startedAt ? ` (${new Date(startedAt).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })})` : '';
  if (month && !taken.has(fullNameKey(base + month) ?? '')) return base + month;
  for (let n = 2; ; n++) { const title = `${base}${month} ${n}`; if (!taken.has(fullNameKey(title) ?? title)) return title; }
}

const firstSentence = (summary: string) => summary.split(/(?<=[.!?])\s/)[0]?.trim() ?? '';

export interface Narrative {
  title: string; kind: EpisodeKind; stage: string | null; status: 'active' | 'closed'; summary: string;
  steps: Record<string, string>; roles: Record<string, MemberRole>;
}

/** The whole narrative for one episode's members (time order is restored here). */
export function narrate(input: {
  members: NarrativeMember[]; entities: NarrativeEntity[]; taken: Set<string>; kind?: string; startedAt?: number | null;
}): Narrative {
  const members = [...input.members].sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.sourceId.localeCompare(b.sourceId));
  const kind = episodeKind(members, input.kind);
  const { own, stage, closed } = runStages(kind, members);
  const title = episodeTitle(kind, input.entities, members, input.taken, input.startedAt ?? members[0]?.at ?? null);
  const summaries = members.map(member => member.summary.trim()).filter(Boolean);
  const summary = summaries.length <= 1 ? summaries[0] ?? ''
    : extractiveSummary(summaries.join('\n'), { sentences: 4, maxChars: 700 }).join(' ') || summaries.at(-1)!;
  const steps: Record<string, string> = {}, roles: Record<string, MemberRole> = {};
  members.forEach((member, index) => {
    const cue = own.get(member.sourceId)?.name;
    const sentence = (member.activity?.stage || firstSentence(member.summary) || member.title).slice(0, 160);
    steps[member.sourceId] = (cue && !sentence.toLowerCase().includes(cue) ? `${cue}: ${sentence}` : sentence).slice(0, 200);
    roles[member.sourceId] = memberRole(kind, member, index === 0);
  });
  return { title, kind, stage, status: closed ? 'closed' : 'active', summary: summary.slice(0, 2000), steps, roles };
}
