import { afterEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createExtensionSDK } from '../sdk';
import { createTestDatabase } from './fixtures/database';
import { run } from '../extensions/knowledge-extractor';
import { ChatStore } from '../sdk/chat/store';
import { transcriptChunks } from '../sdk/chat/transcript';
import type { ChatMessage } from '../sdk/chat/types';
import { applyWrapper, bodyLines, clusterMessages, induceWrapper, messageSubject, subjectSkeleton, wrapperText } from '../lib/graph/templates';
import { boilerplateSources, parseTemplateLabels, templateVerdict } from '../extensions/knowledge-extractor/templates';

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const SENDER = 'admissions@northbridge.org';
const PEOPLE = ['Priya Shah', 'Omar Haddad', 'Lena Park', 'Tom Becker', 'Ana Ruiz', 'Ken Ito'];
const PROGRAMS = ['Robotics Fellowship', 'Data Science Scholarship', 'Climate Lab Internship', 'Quantum Summer Program', 'Bioengineering Residency', 'Design Bootcamp'];
const DATES = ['2026-10-15', '2026-11-03', '2026-11-20', '2026-12-01', '2027-01-09', '2027-02-14'];

function invitation(i: number) {
  return `Subject: ${PEOPLE[i]} invited you to interview for ${PROGRAMS[i]}
From: Northbridge Admissions <${SENDER}>
To: ali@example.com

Dear Ali,
${PEOPLE[i]} invited you to interview for ${PROGRAMS[i]}.
Please book a slot before ${DATES[i]}.
Reply to this email if you have questions.
Northbridge Admissions Team
Northbridge Labs, 1 Main Street
Unsubscribe <https://northbridge.org/u/${i}x${i * 7}>`;
}

/** The same subject, after the sender redesigned the body. */
const REDESIGNED = `Subject: Maya Cole invited you to interview for Ocean Robotics Fellowship
From: Northbridge Admissions <${SENDER}>
To: ali@example.com

Hello there!
Great news from our new portal: your interview with Maya Cole is ready to schedule.
Open the portal to pick a time that works for you, and bring your portfolio.
We look forward to meeting you soon.
The Northbridge Talent Office`;

describe('template induction', () => {
  it('masks variable parts of subjects', () => {
    expect(subjectSkeleton('491582 is your Instagram code')).toBe('<n> is your instagram code');
    expect(subjectSkeleton('Astrid O. commented in Looking for a team')).toBe('<name> commented in looking for a team');
    expect(subjectSkeleton('sata_cable mentioned you in UWASIC')).toBe('<id> mentioned you in uwasic');
    expect(subjectSkeleton('Academy eNews: August 2026')).toBe('academy enews: <date>');
    expect(subjectSkeleton('Reminder: email "Join us" to bob@x.org')).toBe('reminder: email <q> to <email>');
  });

  it('clusters by sender and skeleton, merging similar skeletons and gathering a residual', () => {
    const messages = [
      ...PEOPLE.map((_, i) => ({ id: `a${i}`, sender: SENDER, subject: messageSubject(invitation(i)), text: invitation(i), sentAt: i })),
      ...['Spring sale', 'New arrivals inside', 'Last chance for 10% off', 'Your weekly picks', 'We miss you'].map((subject, i) =>
        ({ id: `p${i}`, sender: 'deals@shop.example', subject, text: `Subject: ${subject}\n\nBody ${i}`, sentAt: i })),
      { id: 'x', sender: 'friend@example.com', subject: 'Lunch?', text: 'Subject: Lunch?\n\nFree today?', sentAt: 0 },
    ];
    const clusters = clusterMessages(messages, { minMembers: 5 });
    expect(clusters.map(cluster => [cluster.sender, cluster.skeleton, cluster.members.length])).toEqual([
      [SENDER, '<name> invited you to interview for <name>', 6],
      ['deals@shop.example', '*', 5],
    ]);
  });

  it('drops headers and quoted replies from bodies, keeping offsets', () => {
    const text = 'Subject: Hi\nFrom: a@b.c\n\n  First line\n> quoted\nSecond line\n\nOn Mon, Jan 5, 2026 Bob wrote:\nold text';
    expect(bodyLines(text).map(line => [line.text, text.slice(line.start, line.start + line.text.length)])).toEqual([
      ['Subject: Hi', 'Subject: Hi'], ['First line', 'First line'], ['Second line', 'Second line']]);
  });

  it('induces a wrapper with line- and token-level slots and reads instances with exact offsets', () => {
    const texts = PEOPLE.map((_, i) => invitation(i));
    const wrapper = induceWrapper(texts)!;
    expect(wrapperText(wrapper)).toBe([
      'Subject : {slot:1} invited you to interview for {slot:2}',
      'Dear Ali,',
      '{slot:3} invited you to interview for {slot:4} .',
      'Please book a slot before {slot:5} .',
      'Reply to this email if you have questions.',
      'Northbridge Admissions Team',
      'Northbridge Labs, 1 Main Street',
      'Unsubscribe <url>',
    ].join('\n'));
    // A new instance, not in the sample.
    const fresh = invitation(0).replaceAll('Priya Shah', 'Maya Cole').replaceAll('Robotics Fellowship', 'Ocean Robotics Fellowship').replace('2026-10-15', '2027-03-01');
    const match = applyWrapper(wrapper, fresh, 0.8)!;
    expect(match.score).toBe(1);
    expect(match.slots.map(slot => [slot.slot, slot.value])).toEqual([[1, 'Maya Cole'], [2, 'Ocean Robotics Fellowship'], [3, 'Maya Cole'],
      [4, 'Ocean Robotics Fellowship'], [5, '2027-03-01']]);
    for (const slot of match.slots) expect(fresh.slice(slot.start, slot.end)).toBe(slot.value);
  });

  it('detects drift: a redesigned body falls below the alignment threshold', () => {
    const wrapper = induceWrapper(PEOPLE.map((_, i) => invitation(i)))!;
    expect(applyWrapper(wrapper, REDESIGNED, 0.8)).toBeNull();
    expect(applyWrapper(wrapper, REDESIGNED)!.score).toBeLessThan(0.3);
    // Extra unexplained lines lower the score too.
    const padded = invitation(1).replace('Dear Ali,', `Dear Ali,\n${'An unexpected paragraph the template never had. '.repeat(8)}`);
    expect(applyWrapper(wrapper, padded)!.score).toBeLessThan(0.8);
  });

  it('validates slot labels strictly against the wrapper and the closed schemas', () => {
    const wrapper = induceWrapper(PEOPLE.map((_, i) => invitation(i)))!;
    expect(() => parseTemplateLabels('{"verdict":"maybe","involvement":"observer"}', wrapper)).toThrow('verdict');
    expect(() => parseTemplateLabels('not json', wrapper)).toThrow('JSON');
    const labels = parseTemplateLabels(JSON.stringify({
      verdict: 'informative', involvement: 'participant',
      slots: [{ slot: 2, kind: 'entity', type: 'Opportunity' }, { slot: 5, kind: 'deadline' }, { slot: 9, kind: 'entity', type: 'Person' },
        { slot: 1, kind: 'entity', type: 'Wizard' }],
      entities: [{ key: 'org', name: 'Northbridge Labs', type: 'Organization' }, { key: 'ghost', name: 'Acme Corp', type: 'Organization' }],
      claims: [{ subject: 'slot:2', predicate: 'OFFERED_BY', object: 'const:org' }, { subject: 'slot:2', predicate: 'HAS_DEADLINE', value: 'slot:5' },
        { subject: 'slot:2', predicate: 'MADE_UP', object: 'const:org' }, { subject: 'const:org', predicate: 'WORKS_AT', object: 'slot:2' },
        { subject: 'slot:2', predicate: 'HAS_DEADLINE', value: 'slot:3' }],
      summary: 'Interview for {slot:2} by {slot:5}.', activity: { kind: 'application', stage: 'interview', label: '{slot:2}' },
    }), wrapper);
    expect(labels.slots).toEqual([{ slot: 1, kind: 'ignore' }, { slot: 2, kind: 'entity', type: 'Opportunity' }, { slot: 3, kind: 'ignore' },
      { slot: 4, kind: 'ignore' }, { slot: 5, kind: 'deadline' }]);
    expect(labels.entities).toEqual([{ key: 'org', name: 'Northbridge Labs', type: 'Organization' }]);
    expect(labels.claims.map(claim => claim.predicate)).toEqual(['OFFERED_BY', 'HAS_DEADLINE']);
    expect(labels.dropped).toBe(6);
    expect(labels.activity).toEqual({ kind: 'application', stage: 'interview', label: '{slot:2}' });
  });
});

const LABELS = {
  verdict: 'informative', involvement: 'participant',
  slots: [{ slot: 1, kind: 'entity', type: 'Person' }, { slot: 2, kind: 'entity', type: 'Opportunity' }, { slot: 3, kind: 'entity', type: 'Person' },
    { slot: 4, kind: 'entity', type: 'Opportunity' }, { slot: 5, kind: 'deadline' }],
  entities: [{ key: 'org', name: 'Northbridge Labs', type: 'Organization' }],
  claims: [{ subject: 'slot:2', predicate: 'OFFERED_BY', object: 'const:org' }, { subject: 'self', predicate: 'INVITED_TO', object: 'slot:2' },
    { subject: 'slot:2', predicate: 'HAS_DEADLINE', value: 'slot:5' }],
  summary: '{slot:3} invited the user to interview for {slot:4}.',
  activity: { kind: 'application', stage: 'invited to interview', label: '{slot:2} application' },
};

function fixture(settings: Record<string, unknown>, labels: object = LABELS) {
  const db = createTestDatabase(); databases.push(db);
  const sdk = createExtensionSDK('knowledge-extractor', { database: db, namespace: 'knowledge' });
  const all = { enabled: true, maxSourcesPerRun: 10, maxContentChars: 12000, namespace: 'knowledge', llmModel: 'test-model', deterministicMode: 'off',
    templateMinMembers: 5, templateMinAlignment: 0.8, maxTemplateLabelsPerRun: 2, maxTemplateInductionsPerRun: 10, ...settings };
  sdk.settings.get = ((key: string) => (all as Record<string, unknown>)[key]) as typeof sdk.settings.get;
  sdk.graph.entities.create({ stableId: 'self', name: 'Ali', type: 'Person', namespace: 'knowledge' });
  const store = new ChatStore(db, 'email', 'email');
  const texts = [...PEOPLE.map((_, i) => invitation(i)), REDESIGNED];
  texts.forEach((text, i) => {
    const sentAt = Date.parse('2026-09-01T12:00:00Z') + i * 86_400_000;
    const message: ChatMessage = { messageId: `<m${i}@northbridge.org>`, authorId: SENDER, authorName: `Northbridge Admissions <${SENDER}>`, sentAt, text, attachments: [] };
    store.upsertConversation({ conversationId: `c${i}`, title: messageSubject(text), kind: 'thread', uri: `email://inbox/thread/c${i}` });
    store.upsertMessages(`c${i}`, [message]);
    store.markIndexed(`w${i}`, `c${i}`, sentAt, sentAt, `h${i}`, `email-window:w${i}`);
    sdk.ingest.sourceAndChunks({ source: { id: `email-window:w${i}`, uri: `email://inbox/thread/c${i}#window=m${i}`, title: `Model-written title ${i}`,
      origin: 'email', type: 'chat_session', hash: `h${i}`, created_at: sentAt, updated_at: sentAt },
    chunks: transcriptChunks([{ ...message, conversationId: `c${i}` }]).map(chunk => ({ text_content: chunk.text_content })) });
  });
  const calls = { label: 0, extract: 0 };
  sdk.queryLLM = (async (prompt: string) => {
    if (prompt.includes('Label the template once')) { calls.label++; return JSON.stringify(labels); }
    calls.extract++;
    return JSON.stringify({ entities: [{ key: 'n', name: 'Northbridge Labs', type: 'Organization' }], claims: [], events: [],
      summary: 'An interview invitation.', involvement: 'participant', activity: null });
  }) as typeof sdk.queryLLM;
  return { db, sdk, calls };
}

describe('template extraction', () => {
  it('active: digests templated mail without the model, grounded in slot quotes; drifted mail goes to the model', async () => {
    const { db, sdk, calls } = fixture({ templateMode: 'active' });
    expect((await run(sdk)).committed).toBe(7);
    expect(calls).toEqual({ label: 1, extract: 1 });
    const template = db.query<{ verdict: string; covered_count: number; labelled_model: string }, []>(
      'SELECT verdict,covered_count,labelled_model FROM graph_email_templates').get()!;
    expect(template).toEqual({ verdict: 'informative', covered_count: 6, labelled_model: 'test-model' });
    const digest = db.query<{ summary: string; involvement: string; activity: string; model: string | null }, []>(
      "SELECT summary,involvement,activity,model FROM graph_source_digests WHERE source_id='email-window:w0'").get()!;
    expect(digest).toMatchObject({ summary: 'Priya Shah invited the user to interview for Robotics Fellowship.', involvement: 'participant', model: null });
    expect(JSON.parse(digest.activity)).toMatchObject({ label: 'Robotics Fellowship application', kind: 'application', stage: 'invited to interview' });
    expect(db.query<{ name: string; type: string }, []>(`SELECT coalesce(e.display_name,e.name) AS name,e.type FROM source_entities se JOIN entities e ON e.id=se.entity_id
      WHERE se.source_id='email-window:w0' ORDER BY 2,1`).all()).toEqual([{ name: 'Robotics Fellowship', type: 'Opportunity' },
      { name: 'Northbridge Labs', type: 'Organization' }, { name: 'Ali', type: 'Person' }, { name: 'Priya Shah', type: 'Person' }]);
    const deadline = sdk.graph.claims.list({ predicate: 'HAS_DEADLINE' }).find(claim => claim.value === '2026-10-15')!;
    expect(deadline).toMatchObject({ method: 'template' });
    expect(sdk.graph.evidence.list(deadline.id)[0]).toMatchObject({ quote: '2026-10-15', method: 'template' });
    const offered = sdk.graph.claims.list({ predicate: 'OFFERED_BY' });
    expect(offered).toHaveLength(6);
    // Per-source mention entities, as for model output: the identity resolver merges them by name later.
    expect(new Set(offered.map(claim => db.query<{ name: string }, [number]>('SELECT coalesce(display_name,name) AS name FROM entities WHERE id=?').get(claim.object!)!.name)))
      .toEqual(new Set(['Northbridge Labs']));
    expect(sdk.graph.claims.list({ predicate: 'INVITED_TO' })).toHaveLength(6);
    // The redesigned message was read by the model.
    expect(db.query("SELECT summary FROM graph_source_digests WHERE source_id='email-window:w6'").get()).toEqual({ summary: 'An interview invitation.' });
    expect(templateVerdict(db, 'email-window:w0')).toMatchObject({ verdict: 'informative' });
    expect(templateVerdict(db, 'email-window:w6')).toBeNull();
    expect((await run(sdk)).committed).toBe(0);
  });

  it('shadow: records the template digest beside the model digest, which still runs', async () => {
    const { db, sdk, calls } = fixture({ templateMode: 'shadow' });
    expect((await run(sdk)).committed).toBe(7);
    expect(calls).toEqual({ label: 1, extract: 7 });
    const rows = db.query<{ subject_key: string; verdict_json: string; llm_verdict_json: string | null }, []>(
      "SELECT subject_key,verdict_json,llm_verdict_json FROM graph_shadow_decisions WHERE kind='template' ORDER BY subject_key").all();
    expect(rows).toHaveLength(6);
    const verdict = JSON.parse(rows[0]!.verdict_json);
    expect(verdict).toMatchObject({ verdict: 'informative', involvement: 'participant', score: 1 });
    expect(verdict.entities.map((entity: { type: string }) => entity.type).sort()).toEqual(['Opportunity', 'Organization', 'Person', 'Person']);
    expect(JSON.parse(rows[0]!.llm_verdict_json!)).toMatchObject({ entities: [{ name: 'Northbridge Labs', type: 'Organization' }], involvement: 'participant' });
    expect(sdk.graph.claims.list({ predicate: 'OFFERED_BY' })).toHaveLength(0);
  });

  it('boilerplate: an empty extraction with the subject as summary, and a verdict for source-filter', async () => {
    const { db, sdk, calls } = fixture({ templateMode: 'active' }, { ...LABELS, verdict: 'boilerplate', involvement: 'observer' });
    expect((await run(sdk)).committed).toBe(7);
    expect(calls.extract).toBe(1);
    expect(db.query("SELECT summary,involvement,entity_ids FROM graph_source_digests WHERE source_id='email-window:w1'").get())
      .toEqual({ summary: 'Omar Haddad invited you to interview for Data Science Scholarship', involvement: 'observer', entity_ids: '[]' });
    expect(sdk.graph.claims.list({ predicate: 'OFFERED_BY' })).toHaveLength(0);
    expect(boilerplateSources(db).sort()).toEqual(PEOPLE.map((_, i) => `email-window:w${i}`));
  });

  it('off: no template tables are touched and every source goes to the model', async () => {
    const { db, sdk, calls } = fixture({ templateMode: 'off' });
    expect((await run(sdk)).committed).toBe(7);
    expect(calls).toEqual({ label: 0, extract: 7 });
    expect(db.query("SELECT 1 FROM sqlite_master WHERE name='graph_email_templates'").get()).toBeNull();
  });
});
