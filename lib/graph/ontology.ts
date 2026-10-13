/**
 * Canonical entity vocabulary for model-extracted knowledge. Connector types (ChatSession, WebPage, …)
 * stay as they are; families decide which types may share one identity when entities are merged.
 */
export const CANONICAL_TYPES = ['Person', 'Organization', 'Project', 'Opportunity', 'Event', 'Artifact', 'Product',
  'Place', 'Concept', 'Course', 'Episode'] as const;
export type CanonicalType = typeof CANONICAL_TYPES[number];

export const CANONICAL_TYPE_HELP: Record<CanonicalType, string> = {
  Person: 'a specific human (not a role)',
  Organization: 'company, club, team, university, lab, community, or institution',
  Project: 'a named effort, codebase, challenge, or assignment someone works on',
  Opportunity: 'a job, internship, co-op, club application, program, scholarship, or competition someone pursues',
  Event: 'a dated meeting, interview, deadline, talk, hackathon, or other occurrence',
  Artifact: 'a repository, document, dataset, paper, form, or other concrete work product',
  Product: 'software, service, tool, library, device, or platform',
  Place: 'a city, building, campus, or other location',
  Concept: 'a technical topic, skill, or idea',
  Course: 'an academic course or class',
  Episode: 'an ongoing pursuit spanning sources over time',
};

const SYNONYMS: Record<string, CanonicalType> = {
  person: 'Person', people: 'Person', human: 'Person', user: 'Person', individual: 'Person', contact: 'Person',
  author: 'Person', recruiter: 'Person', student: 'Person',
  organization: 'Organization', organisation: 'Organization', org: 'Organization', company: 'Organization',
  club: 'Organization', team: 'Organization', university: 'Organization', school: 'Organization',
  institution: 'Organization', lab: 'Organization', group: 'Organization', community: 'Organization',
  employer: 'Organization', startup: 'Organization', nonprofit: 'Organization', agency: 'Organization',
  project: 'Project', challenge: 'Project', assignment: 'Project', initiative: 'Project', codebase: 'Project',
  opportunity: 'Opportunity', job: 'Opportunity', role: 'Opportunity', position: 'Opportunity', internship: 'Opportunity',
  coop: 'Opportunity', 'co-op': 'Opportunity', application: 'Opportunity', program: 'Opportunity', programme: 'Opportunity',
  scholarship: 'Opportunity', competition: 'Opportunity', mentorship: 'Opportunity',
  event: 'Event', meeting: 'Event', interview: 'Event', deadline: 'Event', talk: 'Event', hackathon: 'Event',
  conference: 'Event', workshop: 'Event', call: 'Event',
  artifact: 'Artifact', repository: 'Artifact', repo: 'Artifact', document: 'Artifact', file: 'Artifact',
  dataset: 'Artifact', paper: 'Artifact', form: 'Artifact', webpage: 'Artifact', 'web resource': 'Artifact', url: 'Artifact',
  product: 'Product', software: 'Product', service: 'Product', tool: 'Product', library: 'Product', framework: 'Product',
  platform: 'Product', device: 'Product', app: 'Product', application_software: 'Product', technology: 'Product',
  place: 'Place', location: 'Place', city: 'Place', country: 'Place', building: 'Place', campus: 'Place',
  concept: 'Concept', topic: 'Concept', skill: 'Concept', idea: 'Concept', field: 'Concept', subject: 'Concept',
  course: 'Course', class: 'Course',
  episode: 'Episode',
};

/** Map a free-text model type onto the ontology; unknown labels become Concept rather than new types. */
export function canonicalType(type: string): CanonicalType {
  const exact = CANONICAL_TYPES.find(name => name === type);
  if (exact) return exact;
  const key = type.trim().toLowerCase().replace(/[_\s]+/g, ' ');
  return SYNONYMS[key] ?? SYNONYMS[key.replace(/s$/, '')] ?? SYNONYMS[key.split(' ').at(-1) ?? ''] ?? 'Concept';
}

/** Connector types that denote the same kind of thing as a canonical family. */
const CONNECTOR_FAMILIES: Record<string, string> = {
  Bot: 'Person', EmailAddress: 'Person', Topic: 'Concept', Server: 'Community', Tag: 'Concept',
  WebPage: 'WebPage', Domain: 'Domain', DevelopmentArea: 'Concept', CareerInterest: 'Concept',
};

/** Two entities may share an identity only when their families agree. */
export function typeFamily(type: string): string {
  if ((CANONICAL_TYPES as readonly string[]).includes(type)) return type;
  if (type in CONNECTOR_FAMILIES) return CONNECTOR_FAMILIES[type]!;
  const key = type.trim().toLowerCase().replace(/[_\s]+/g, ' ');
  return SYNONYMS[key] ?? type;
}

export const sameFamily = (a: string, b: string) => typeFamily(a) === typeFamily(b);

/** Types worth listing when a model is asked which known things a source mentions. */
export const REGISTRY_FAMILIES = new Set<string>(['Person', 'Organization', 'Project', 'Opportunity', 'Event', 'Artifact',
  'Product', 'Place', 'Course', 'Episode', 'Community']);
