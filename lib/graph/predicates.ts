import { CANONICAL_TYPES, typeFamily, type CanonicalType } from './ontology';

/**
 * A closed, typed relation schema for extracted claims. The model used to invent a predicate per claim (2,374
 * distinct, 1,577 used once), which made claims unqueryable. `canonicalPredicate` maps any raw predicate onto
 * this schema deterministically: lemmatise, look up synonyms (built from the production distribution), apply head
 * rules, and keep the first candidate whose domain/range fit the claim. Anything else becomes RELATED_TO with the
 * original wording as its label, and callers keep the raw predicate in `qualifiers.rawPredicate`, so nothing is lost.
 *
 * Domain and range are enforced here, not through `GraphRelations` type constraints: those compare exact entity
 * types (connector types such as EmailAddress or Bot would be refused) and `define()` revalidates live claims, so a
 * mismatch would abort an extraction commit. `registerPredicates` declares names, inverses, and transitivity only.
 */
type Types = readonly CanonicalType[];
export interface PredicateDefinition {
  name: string;
  description: string;
  /** Subject types (canonical families); undefined means any. */
  domain?: Types;
  /** Entity object types; undefined means any entity, [] means literal values only. */
  range?: Types;
  /** Kind of literal value the predicate accepts; undefined means entity objects only. */
  value?: 'date' | 'text' | 'number' | 'any';
  inverse?: string;
  symmetric?: boolean;
  transitive?: boolean;
  /** At most one current target per subject (deadlines, start/end dates, employer of an opportunity). */
  functional?: boolean;
}

const PEOPLE: Types = ['Person'];
const ACTORS: Types = ['Person', 'Organization'];
const PURSUITS: Types = ['Opportunity', 'Organization', 'Course', 'Event', 'Project'];
const DATED: Types = ['Opportunity', 'Event', 'Project', 'Course', 'Artifact', 'Product', 'Organization'];
const WORKS: Types = ['Artifact', 'Project', 'Product', 'Course', 'Concept'];
const ANY = undefined;

export const PREDICATES: readonly PredicateDefinition[] = [
  { name: 'APPLIED_TO', description: 'applied to an opportunity, program, school, or course', domain: PEOPLE, range: PURSUITS, inverse: 'HAS_APPLICANT' },
  { name: 'ACCEPTED_TO', description: 'was accepted or admitted to', domain: PEOPLE, range: PURSUITS, inverse: 'ACCEPTED' },
  { name: 'REJECTED_FROM', description: 'was rejected or declined by', domain: PEOPLE, range: PURSUITS, inverse: 'REJECTED' },
  { name: 'INVITED_TO', description: 'was invited to', domain: ACTORS, range: PURSUITS, inverse: 'HAS_INVITEE' },
  { name: 'OFFERED_BY', description: 'an opportunity, course, or product offered, posted, or run by', domain: ['Opportunity', 'Course', 'Product', 'Event', 'Project'], range: ACTORS, inverse: 'OFFERS', functional: true },
  { name: 'OFFERS', description: 'offers an opportunity, course, product, or perk', domain: ['Organization', 'Person', 'Product', 'Opportunity', 'Event', 'Project', 'Course'], range: ['Opportunity', 'Course', 'Product', 'Event', 'Project', 'Concept'], value: 'text', inverse: 'OFFERED_BY' },
  { name: 'WORKS_AT', description: 'is employed by or works for', domain: PEOPLE, range: ['Organization'], inverse: 'EMPLOYS' },
  { name: 'STUDIES_AT', description: 'is a student or alumnus of', domain: PEOPLE, range: ['Organization'], inverse: 'HAS_STUDENT' },
  { name: 'MEMBER_OF', description: 'is a member of a club, team, community, or group', domain: ACTORS, range: ['Organization', 'Project'], inverse: 'HAS_MEMBER' },
  { name: 'AFFILIATED_WITH', description: 'is affiliated or associated with an organization', domain: ['Person', 'Organization', 'Project', 'Event', 'Opportunity', 'Product'], range: ['Organization'], inverse: 'HAS_AFFILIATE' },
  { name: 'ENROLLED_IN', description: 'is enrolled or registered in a course or program', domain: PEOPLE, range: ['Course', 'Opportunity', 'Event'], inverse: 'HAS_ENROLLEE' },
  { name: 'LOCATED_IN', description: 'is located, based, registered, or held at a place (or a stated address)', domain: ['Organization', 'Event', 'Place', 'Opportunity', 'Person', 'Product', 'Project', 'Artifact', 'Course'], range: ['Place'], value: 'text', inverse: 'LOCATION_OF', transitive: true },
  { name: 'PART_OF', description: 'is a component, section, or subdivision of', inverse: 'HAS_PART', transitive: true },
  { name: 'HAS_PART', description: 'includes or contains', inverse: 'PART_OF' },
  { name: 'ORGANIZED_BY', description: 'an event, program, or project hosted, organized, or run by', domain: ['Event', 'Opportunity', 'Project', 'Course', 'Product', 'Artifact'], range: ACTORS, inverse: 'ORGANIZES' },
  { name: 'ORGANIZES', description: 'hosts, organizes, or runs', domain: ACTORS, range: ['Event', 'Opportunity', 'Project', 'Course', 'Product'], inverse: 'ORGANIZED_BY' },
  { name: 'ATTENDED', description: 'attended or took part in an event, course, or program', domain: PEOPLE, range: ['Event', 'Course', 'Opportunity', 'Project'], inverse: 'ATTENDED_BY' },
  { name: 'SENT_TO', description: 'sent a message, email, notification, or item to', domain: ['Person', 'Organization', 'Product', 'Artifact', 'Event'], range: ACTORS, inverse: 'RECEIVED_FROM' },
  { name: 'RECEIVED_FROM', description: 'received a message or item from', domain: ACTORS, range: ['Person', 'Organization', 'Product'], inverse: 'SENT_TO' },
  { name: 'SENT', description: 'sent or submitted a document or item', domain: ['Person', 'Organization', 'Product'], range: ['Artifact', 'Opportunity', 'Event', 'Product', 'Project'], value: 'text', inverse: 'SENT_BY' },
  { name: 'RECEIVED', description: 'received a document, award, offer, or item', domain: ACTORS, range: ['Artifact', 'Opportunity', 'Event', 'Product', 'Course', 'Concept'], value: 'text', inverse: 'RECEIVED_BY' },
  { name: 'MENTORS', description: 'mentors or coaches', domain: ACTORS, range: ['Person', 'Project', 'Organization'], inverse: 'MENTORED_BY' },
  { name: 'AUTHORED', description: 'wrote, created, developed, or published', domain: ACTORS, range: WORKS, inverse: 'AUTHORED_BY' },
  { name: 'AUTHORED_BY', description: 'written, created, developed, or published by', domain: WORKS, range: ACTORS, inverse: 'AUTHORED' },
  { name: 'USES', description: 'uses a tool, platform, language, or service', domain: ['Person', 'Organization', 'Project', 'Product', 'Artifact', 'Opportunity'], range: ['Product', 'Concept', 'Artifact', 'Project'], inverse: 'USED_BY' },
  { name: 'OWNS', description: 'owns or controls (or a named trademark or asset)', domain: ACTORS, range: ['Product', 'Organization', 'Artifact', 'Project', 'Place'], value: 'text', inverse: 'OWNED_BY' },
  { name: 'OWNED_BY', description: 'owned or controlled by', domain: ['Product', 'Organization', 'Artifact', 'Project', 'Place'], range: ACTORS, inverse: 'OWNS' },
  { name: 'PAID', description: 'paid or transferred money to', domain: ACTORS, range: ACTORS, value: 'any', inverse: 'PAID_BY' },
  { name: 'PURCHASED', description: 'bought or ordered', domain: ACTORS, range: ['Product', 'Artifact', 'Opportunity', 'Event', 'Course'], value: 'text', inverse: 'PURCHASED_BY' },
  { name: 'RECOMMENDS', description: 'recommends or suggests', domain: ['Person', 'Organization', 'Artifact', 'Product'], value: 'text', inverse: 'RECOMMENDED_BY' },
  { name: 'CHOSE', description: 'chose, selected, or decided on', domain: ['Person', 'Organization', 'Project'], value: 'text', inverse: 'CHOSEN_BY' },
  { name: 'REQUIRES', description: 'requires a document, skill, membership, or step', value: 'text', inverse: 'REQUIRED_BY' },
  { name: 'HAS_TOPIC', description: 'is about or covers a topic', range: ['Concept', 'Product', 'Organization', 'Project', 'Course'], value: 'text', inverse: 'TOPIC_OF' },
  { name: 'INSTANCE_OF', description: 'is a kind of, or categorised as', value: 'text', inverse: 'HAS_INSTANCE' },
  { name: 'INTERESTED_IN', description: 'is interested in or wants', domain: ACTORS, value: 'text', inverse: 'INTEREST_OF' },
  { name: 'SUBSCRIBED_TO', description: 'subscribed to or follows a list, organization, or service', domain: PEOPLE, range: ['Organization', 'Product', 'Concept', 'Artifact', 'Project'], value: 'text', inverse: 'HAS_SUBSCRIBER' },
  { name: 'TEACHES', description: 'teaches a course or subject', domain: ACTORS, range: ['Course', 'Concept'], value: 'text', inverse: 'TAUGHT_BY' },
  { name: 'MENTIONS', description: 'mentions, cites, or asks about', domain: ['Person', 'Organization', 'Artifact', 'Project', 'Event'], value: 'text', inverse: 'MENTIONED_BY' },
  { name: 'HAS_DEADLINE', description: 'deadline or closing date (literal date or deadline event)', domain: DATED, range: ['Event'], value: 'date', functional: true },
  { name: 'SCHEDULED_FOR', description: 'date or time something takes place', domain: DATED, range: ['Event'], value: 'date', functional: true },
  { name: 'STARTS_ON', description: 'start date', domain: DATED, value: 'date', range: [], functional: true },
  { name: 'ENDS_ON', description: 'end or expiry date', domain: [...DATED, 'Concept'], value: 'date', range: [], functional: true },
  { name: 'HAS_ROLE', description: 'a role, title, or position someone holds (or the opportunity for it)', domain: ['Person', 'Organization'], range: ['Opportunity'], value: 'text' },
  { name: 'HAS_STATUS', description: 'current status or stage', value: 'text', range: [] },
  { name: 'HAS_PRICE', description: 'price, cost, fee, discount, or amount', value: 'any', range: [] },
  { name: 'HAS_DURATION', description: 'length of time', value: 'any', range: [] },
  { name: 'HAS_IDENTIFIER', description: 'registration, reference, account, or company number', value: 'any', range: [] },
  { name: 'HAS_CONTACT', description: 'email address, phone, or website', value: 'text', range: ['Person', 'Organization', 'Product', 'Artifact'] },
  { name: 'STATED', description: 'said, argued, announced, or posted (the statement as text)', domain: ['Person', 'Organization', 'Artifact', 'Concept', 'Product'], value: 'text', range: ['Artifact', 'Opportunity', 'Event'] },
  { name: 'HAS_NAME', description: 'a title or formal name', value: 'text', range: [] },
  { name: 'DEFINED_AS', description: 'meaning or definition', value: 'text', range: ['Concept'] },
  { name: 'HAS_FEATURE', description: 'a feature, benefit, function, or reward', value: 'text', range: ['Concept', 'Product'] },
  { name: 'HAS_AUDIENCE', description: 'who it is for', value: 'text', range: ['Person', 'Organization', 'Concept'] },
  { name: 'RELATED_TO', description: 'anything else; the wording goes in qualifiers.label', value: 'any', symmetric: true },
];

const BY_NAME = new Map(PREDICATES.map(definition => [definition.name, definition]));
// Inverse names are canonical too ("EMPLOYS" is WORKS_AT read backwards), with domain and range swapped.
for (const definition of PREDICATES) {
  if (!definition.inverse || BY_NAME.has(definition.inverse) || definition.value === 'date') continue;
  BY_NAME.set(definition.inverse, { name: definition.inverse, description: `inverse of ${definition.name}`, inverse: definition.name,
    domain: definition.range?.length ? definition.range : undefined, range: definition.domain, transitive: definition.transitive });
}
export const PREDICATE_NAMES = new Set(BY_NAME.keys());

/** Predicates written by code (digests, connectors, events), not chosen by the model: kept as they are. */
const SYSTEM = new Set(['MENTIONS_ENTITY', 'DESCRIPTION', 'SUMMARY', 'EVENT_KIND', 'COVERS_TOPIC', 'EXPANDED_CONTEXT', 'COREFERS_TO',
  'HAS_ALIAS', 'COMPLEMENTS', 'EXPANDS_UPON', 'EXPANDED_BY', 'REFERENCES', 'REFERENCED_BY', 'RELATES_TO', 'PART_OF_EPISODE',
  'HAS_EPISODE_MEMBER', 'INVOLVES', 'INVOLVED_IN', 'SOURCE_URI', 'PLATFORM', 'IN_CONVERSATION', 'PARTICIPATED_IN', 'SHARES_LINK']);
export const isSystemPredicate = (predicate: string) => SYSTEM.has(predicate) || predicate.startsWith('ROLE:');

const IRREGULAR: Record<string, string> = {
  sent: 'send', wrote: 'write', written: 'write', held: 'hold', built: 'build', taught: 'teach', made: 'make', paid: 'pay',
  bought: 'buy', began: 'begin', begun: 'begin', chose: 'choose', chosen: 'choose', ran: 'run', took: 'take', taken: 'take',
  said: 'say', told: 'tell', found: 'find', brought: 'bring', won: 'win', led: 'lead', met: 'meet', gave: 'give', given: 'give',
  got: 'get', gotten: 'get', went: 'go', gone: 'go', saw: 'see', seen: 'see', knew: 'know', known: 'know', spoke: 'speak',
  left: 'leave', kept: 'keep', sold: 'sell', spent: 'spend', has: 'have', had: 'have', having: 'have', does: 'do', did: 'do',
  done: 'do', became: 'become', underwent: 'undergo', drew: 'draw', grew: 'grow', taught_at: 'teach',
};
/** Auxiliaries and articles carry no relation meaning ("is located at" = "located_at"). */
const NEGATIONS = new Set(['not', 'no', 'never', 'non', 'without', 'unable', 'cannot', 'fail', 'failed', 'deny', 'denied']);
const DROP = new Set(['is', 'are', 'was', 'were', 'be', 'been', 'being', 'a', 'an', 'the', 'its', 'their', 'his', 'her', 'currently', 'also']);

/** Base forms the lemmatiser may land on; a token is reduced only to a word in this list (or by a safe plural rule). */
const LEMMAS = new Set(`apply accept admit reject decline invite offer provide work employ study enroll enrol register locate base headquarter
  organize organise host run operate attend participate join send receive mentor coach author write create develop build make publish
  use own control pay transfer donate purchase buy order recommend suggest choose select pick decide opt require need include contain
  subscribe follow teach instruct mention cite reference state say argue quote claim note explain mean define describe schedule occur
  happen hold start begin end close expire finish open post share announce feature focus cover explore categorize categorise classify
  belong serve partner sponsor manage lead support power promote release launch complete submit sign award win earn graduate intern
  visit travel depart arrive cost charge price discount list deliver ship notify email message contact call meet interview take
  affiliate associate locate situate base found establish due deadline date time location address venue place topic theme subject
  category type kind role position title status duration length number code identifier reference fee amount percentage salary stipend
  benefit perk reward audience target name label meaning definition summary student member employee alumnus alumni intern applicant
  recipient sender owner creator developer organizer organiser host speaker instructor teacher mentor employer sponsor partner
  respond reply appear involve interest support show protect carry lead character
  from on at in to by for with of about as into under upon via over through`.split(/\s+/).filter(Boolean));

function lemma(token: string): string {
  if (IRREGULAR[token]) return IRREGULAR[token]!;
  if (LEMMAS.has(token)) return token;
  const candidates = [
    token.replace(/ies$/, 'y'), token.replace(/ied$/, 'y'), token.replace(/es$/, ''), token.replace(/s$/, ''),
    token.replace(/ed$/, ''), token.replace(/d$/, ''), token.replace(/ing$/, ''), token.replace(/ing$/, 'e'),
    token.replace(/([b-df-hj-np-tv-z])\1(ed|ing)$/, '$1'), token.replace(/ment$/, ''), token.replace(/ation$/, 'e'), token.replace(/ation$/, ''),
  ];
  const known = candidates.find(candidate => candidate !== token && LEMMAS.has(candidate));
  if (known) return known;
  return token.length > 3 && /[^su]s$/.test(token) ? token.slice(0, -1) : token;
}

/** snake_case, camelCase, spaced, or upper-case predicates → lemmatised tokens ("sentEmailTo" → send email to). */
export function predicateTokens(raw: string): string[] {
  return raw.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(token => token && !DROP.has(token)).map(lemma);
}

/**
 * Head rules over the lemmatised key (tokens joined by "_"). Each lists candidate predicates in order of preference;
 * the first whose domain/range fit the claim is used. Ordered so specific wording wins ("application_deadline"
 * before "application"). Built from the most frequent raw predicates in production (top ~300 cover ~65% of claims).
 */
const RULES: Array<[RegExp, string[]]> = [
  [/(^|_)(deadline|due)(_|$)|^(abstract|application|job|submission|registration)_(deadline|due|close)/, ['HAS_DEADLINE']],
  [/(^|_)(number|id|code|identifier|reference_number|registration_number|vat|account_number|no)$|^(vat|company_number|student_number)/, ['HAS_IDENTIFIER']],
  [/^(close|closing|clos)(_date|_on|_at)?$|^application_close/, ['HAS_DEADLINE', 'ENDS_ON']],
  [/^(expire|expiry|expiration|valid_until|end_date|end_on|end_at|end_time|end|finish|open_until)(_|$)|^(expire|expiry)(_|$)/, ['ENDS_ON', 'HAS_DEADLINE']],
  [/^(start|begin|open|launch)(_date|_on|_at|_time)?$/, ['STARTS_ON']],
  [/^(schedule|occur|happen|take_place|hold|event_date|date|time|when|depart|departure|arrival|arrive)(_|$)|_(date|time|day)$|^(occur|happen|hold)_(on|at)$/, ['SCHEDULED_FOR']],
  [/^apply(_|$)|^applicant_|^submit_application/, ['APPLIED_TO']],
  [/^(accept|admit|admission|receive_acceptance|accept_offer)(_|$)/, ['ACCEPTED_TO']],
  [/^(reject|decline|turn_down)(_|$)/, ['REJECTED_FROM']],
  [/^invite(_|$)|^(receive_)?invitation/, ['INVITED_TO']],
  [/^(employer|offer_by|offered_by|provide_by|post_by|posted_by|is_offer_by|run_by|operate_by|publish_by)$/, ['OFFERED_BY', 'AUTHORED_BY', 'ORGANIZED_BY']],
  [/^(host|organize|organise|co_host|sponsor|run|operate|power)(_by)$|^(organizer|host)$/, ['ORGANIZED_BY', 'OFFERED_BY']],
  [/^(host|organize|organise|run|operate|sponsor|power)(_|$)/, ['ORGANIZES', 'OFFERS']],
  [/^(author|write|create|develop|build|make|design|compose|produce)_(by)$|^(author|creator|developer|developed_by)$|^publish_by$/, ['AUTHORED_BY']],
  [/^(author_of|author|write|create|develop|build|make|design|compose|produce|publish|release|launch|complete)(_|$)/, ['AUTHORED', 'OFFERS']],
  [/^(offer|provide|post_job|give|grant|award)(_|$)/, ['OFFERS', 'STATED']],
  [/^(share|post|tweet|publish_post)(_|$)/, ['STATED', 'OFFERS', 'AUTHORED', 'SENT']],
  [/^(work|employ|employee|job|intern|works)(_|$)|^(role|position)_at$/, ['WORKS_AT']],
  [/^(study|student|alumnus|alumni|graduate|educate|attend_school|is_student)(_|$)/, ['STUDIES_AT']],
  [/^(member|join|is_member)(_|$)|_member_of$/, ['MEMBER_OF', 'SUBSCRIBED_TO', 'PART_OF']],
  [/^belong_to$/, ['MEMBER_OF', 'PART_OF', 'OWNED_BY']],
  [/^(affiliate|affiliation|associate|associated|partner|associated_institution)(_|$)/, ['AFFILIATED_WITH', 'RELATED_TO']],
  [/^(enroll|enrol|register|registration|sign_up|signed_up|take_course|take)(_for|_in|_at|$)/, ['ENROLLED_IN', 'SUBSCRIBED_TO', 'MEMBER_OF']],
  [/^(locate|location|base|headquarter|headquarters|situate|address|venue|place|register_in|register_office|office|mailing_address|origin|destination|depart|arrive|citizen_of|is_citizen|live|reside|in)(_|$)/, ['LOCATED_IN']],
  [/^(appear|feature|character|cite|list|show)_(in|by|on)$/, ['MENTIONED_BY']],
  [/^(recipient|respond_to|reply_to)$/, ['SENT_TO']],
  [/^(have_participant|participant)$/, ['ATTENDED_BY']],
  [/^(have_sponsor|sponsor_by|lead_by|led_by|run_by)$/, ['ORGANIZED_BY', 'OWNED_BY']],
  [/^(professor|lecturer|researcher|engineer|former_role|current_role|intern|teach)_(at|for)$|^(is_professor|is_instructor)_/, ['WORKS_AT', 'TEACHES']],
  [/^(involve|involves)(_|$)/, ['HAS_PART', 'HAS_TOPIC']],
  [/^ask(_about)?$/, ['MENTIONS']],
  [/^(interest|interested|want|wish|plan_to|consider)(_|$)/, ['INTERESTED_IN']],
  [/^(host_on|run_on|deploy_on|available_on|built_on)$/, ['USES']],
  [/^(part_of|component_of|section_of|subdivision_of|belong|divide_into|is_part)(_|$)|_part_of$/, ['PART_OF']],
  [/^(include|contain|consist|comprise|have_part|have_section)(_|$)/, ['HAS_PART', 'HAS_FEATURE', 'HAS_TOPIC']],
  [/^(attend|participate|took_part|take_part|guest_on|speaker|compete|visit)(_|$)/, ['ATTENDED', 'STUDIES_AT', 'MEMBER_OF']],
  [/^(send|email|message|notify|notification|forward|reply|respond|write_to|contact|reach_out|sent)(_.*)?_(to|on_behalf_of)$|^(send|email|message|notify)$|^(send|sent)_(email|message|notification)/, ['SENT_TO', 'SENT']],
  [/^(send|submit|deliver|ship|share|forward|upload|transfer_document)(_|$)/, ['SENT', 'SENT_TO', 'STATED']],
  [/^(receive|get|recipient|offer|win|earn)(_.*)?_from$/, ['RECEIVED_FROM']],
  [/^(receive|get|recipient|win|earn|obtain)(_|$)/, ['RECEIVED', 'RECEIVED_FROM']],
  [/^(mentor|coach|advise|supervise|tutor)(_|$)|(^|_)coach_(for|of)$/, ['MENTORS']],
  [/^(use|utilize|run_on|build_with|built_with|written_in|write_in|uses|use_platform|use_tool|use_framework|use_service|use_language|support_operating_system|know_language|have_skill|skill)(_|$)/, ['USES', 'HAS_FEATURE']],
  [/^(own|control|manage|operate|lead|run|head|found|co_founder|establish)(_|$)|^is_co_founder/, ['OWNS', 'ORGANIZES', 'AFFILIATED_WITH']],
  [/^(owned_by|own_by|control_by|manage_by|founded_by|found_by)$/, ['OWNED_BY', 'ORGANIZED_BY']],
  [/^(pay|transfer|donate|refund|send_transfer|sent_transfer|accept_transfer|charge)(_|$)/, ['PAID', 'HAS_PRICE']],
  [/^(buy|purchase|order|subscribe_plan|book)(_|$)/, ['PURCHASED']],
  [/^(recommend|suggest|endorse|promote|advertise|suggested_connection|suggest_connection)(_|$)/, ['RECOMMENDS']],
  [/^(choose|select|pick|decide|opt|prefer|adopt)(_|$)/, ['CHOSE']],
  [/^(require|need|prerequisite|missing|must)(_|$)|^is_missing$/, ['REQUIRES']],
  [/^(subscribe|follow|receive_notification|receive_email|newsletter|signed_up_for)(_|$)/, ['SUBSCRIBED_TO', 'RECEIVED_FROM']],
  [/^(teach|instruct|lecture|teacher|instructor)(_|$)/, ['TEACHES']],
  [/^(mention|cite|reference|refer|quote_from|discuss)(_|$)/, ['MENTIONS', 'HAS_TOPIC']],
  [/^(state|say|argue|quote|claim|note|explain|announce|post|share|tweet|write_about|comment|observe|observation|report|ask)(_|$)/, ['STATED', 'MENTIONS', 'AUTHORED']],
  [/^(mean|meaning|define|definition|defined_as|describe|described_as|is_describe_as|is_defined_as|symbolize|represent|characterize)(_|$)/, ['DEFINED_AS', 'INSTANCE_OF']],
  [/^(role|position|title|job_title|is_title|have_role|have_title|occupation|degree|serve_as)(_|$)/, ['HAS_ROLE', 'HAS_NAME']],
  [/^(status|stage|state_of|registration_status|application_status|progress)(_|$)|_status$/, ['HAS_STATUS']],
  [/(^|_)(price|cost|fee|discount|percentage|amount|salary|stipend|pay_rate|budget|deposit|charge|starting_price|free_shipping|coupon|rebate|reward_point)(_|$)/, ['HAS_PRICE']],
  [/(^|_)(duration|length|session_duration|hour|week|month)(_|$)/, ['HAS_DURATION']],
  [/(^|_)(email|phone|website|url|contact|twitter|linkedin|handle|social_media)(_|$)/, ['HAS_CONTACT']],
  [/^(topic|theme|subject|about|cover|focus|explore|regard|concern|include_topic|have_topic|is_about)(_|$)|_topic$/, ['HAS_TOPIC']],
  [/^(category|type|kind|is_a|is_type|instance|classify|categorize|categorise|belong_to_category|have_category|have_type|genre|example_of)(_|$)|^categor/, ['INSTANCE_OF']],
  [/(^|_)(feature|function|benefit|perk|reward|mentor_benefit|capability|offer_feature|purpose|allow)(_|$)/, ['HAS_FEATURE']],
  [/(^|_)(audience|target|age_group|eligible|eligibility)(_|$)|^(for|design_for|intend_for|aim_at|hire_for|hiring_for)$/, ['HAS_AUDIENCE']],
  [/^(name|legal_name|have_name|call|title|alias|known_as|aka)(_|$)/, ['HAS_NAME']],
  [/^have$|^have_(feature|characteristic|trait|property)/, ['HAS_FEATURE']],
];

const familyOf = (type: string | undefined): CanonicalType | 'unknown' => {
  if (type === undefined) return 'unknown';
  const family = typeFamily(type);
  if (family === 'Community') return 'Organization';
  return (CANONICAL_TYPES as readonly string[]).includes(family) ? family as CanonicalType : 'unknown';
};

/**
 * Whether a predicate fits a claim. `objectType` undefined means unknown (any entity passes), null means the claim
 * carries a literal value. Unknown or connector subject types pass the domain check: they cannot be verified.
 */
export function fits(definition: PredicateDefinition, subjectType?: string, objectType?: string | null) {
  const subject = familyOf(subjectType);
  if (definition.domain && subject !== 'unknown' && !definition.domain.includes(subject)) return false;
  if (objectType === null) return definition.value !== undefined;
  if (objectType === undefined) return !(definition.range && !definition.range.length);
  const object = familyOf(objectType);
  if (definition.range && !definition.range.length) return false;
  return !definition.range || object === 'unknown' || definition.range.includes(object);
}

export interface CanonicalPredicate {
  predicate: string;
  /** The original wording, for RELATED_TO (callers store it as qualifiers.label). */
  label?: string;
  confidence: number;
  basis: 'system' | 'schema' | 'rule' | 'fallback';
}

/**
 * Map a raw model predicate onto the schema. `objectType` null means the claim has a literal value; undefined
 * means unknown. Deterministic and total: unmapped wording returns RELATED_TO with the raw predicate as its label.
 */
export function canonicalPredicate(raw: string, subjectType?: string, objectType?: string | null): CanonicalPredicate {
  const trimmed = raw.trim();
  if (isSystemPredicate(trimmed)) return { predicate: trimmed, confidence: 1, basis: 'system' };
  const upper = trimmed.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  const exact = BY_NAME.get(upper);
  if (exact && upper !== 'RELATED_TO' && fits(exact, subjectType, objectType)) return { predicate: exact.name, confidence: 1, basis: 'schema' };
  if (upper === 'RELATED_TO' || upper === 'RELATES_TO') return { predicate: 'RELATED_TO', confidence: 0.3, basis: 'fallback' };
  const tokens = predicateTokens(trimmed);
  // Mapping a negated phrase ("was_not_admitted_to") onto its positive predicate would invert the claim.
  if (tokens.some(token => NEGATIONS.has(token))) return { predicate: 'RELATED_TO', label: trimmed.slice(0, 120), confidence: 0.3, basis: 'fallback' };
  // "is a" / "is" lose every token to the auxiliary filter; they still say what kind of thing the subject is.
  const key = tokens.length ? tokens.join('_') : /^(is|is_a|is_an|are|was)$/.test(trimmed.toLowerCase().replace(/\s+/g, '_')) ? 'is_a' : '';
  // "has_deadline", "has_email": the noun after "have" names the relation.
  for (const candidate of [key, ...(key.startsWith('have_') ? [key.slice(5)] : [])]) {
    if (candidate) for (const [pattern, names] of RULES) {
      if (!pattern.test(candidate)) continue;
      for (const name of names) {
        const definition = BY_NAME.get(name);
        if (definition && name !== 'RELATED_TO' && fits(definition, subjectType, objectType)) return { predicate: name, confidence: 0.75, basis: 'rule' };
      }
    }
  }
  return { predicate: 'RELATED_TO', label: trimmed.slice(0, 120), confidence: 0.3, basis: 'fallback' };
}

/** Declare the schema's names, inverses, and transitivity once (type constraints stay in `fits`, see above). */
export function registerPredicates(relations: { get(name: string): unknown; define(definition: { name: string; description?: string; inverse?: string; symmetric?: boolean; transitive?: boolean }): void }) {
  for (const definition of PREDICATES) {
    if (relations.get(definition.name)) continue;
    relations.define({ name: definition.name, description: definition.description,
      ...(definition.symmetric ? { symmetric: true } : definition.inverse ? { inverse: definition.inverse } : {}),
      ...(definition.transitive ? { transitive: true } : {}) });
  }
}

/** The enum given to the model: names with domain → range, one per line. */
export function predicatePrompt(): string {
  return PREDICATES.map(definition => {
    const domain = definition.domain?.join('|') ?? 'any';
    const objects = [...(definition.range === undefined ? ['any entity'] : definition.range), ...(definition.value ? [`${definition.value} value`] : [])];
    return `${definition.name} (${domain} → ${objects.join('|')}): ${definition.description}`;
  }).join('\n');
}
