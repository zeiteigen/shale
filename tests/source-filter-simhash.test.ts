import { afterEach, describe, expect, it } from 'bun:test';
import { bands, hamming, simhash } from '../lib/text/simhash';
import { random } from '../lib/text/softmax';
import { classify } from '../extensions/source-filter/rules';
import { sourceFeatures } from '../extensions/source-filter/features';
import { producerKey } from '../extensions/source-filter/near-duplicates';
import { run } from '../extensions/source-filter';
import { filterFixture } from './fixtures/source-filter';

const fixtures: ReturnType<typeof filterFixture>[] = [];
const setup = (...args: Parameters<typeof filterFixture>) => { const fixture = filterFixture(...args); fixtures.push(fixture); return fixture; };
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

const DIGEST = (day: number, sender = 'Launchpad <hello@launchpad.test>') => `[09:0${day % 10}] ${sender}: Subject: Daily Discussions Digest
Check out the new discussions on Launchpad this week from students around the world.
Introduction: hello, I am currently studying in grade nine and I love building robots and science fair projects.
Looking for team members and mentors for the wearables challenge, join our team today.
Minerals of technology: is there anyone interested in discussing rare earth supply chains with us?
Read more discussions and reply to your classmates on the Launchpad community board now.
Digest number ${day}.`;

describe('SimHash', () => {
  it('keeps near-identical texts within a few bits and unrelated texts far apart', () => {
    const body = (day: number) => DIGEST(day).replace(/^\[[^\]]+\]\s+[^:]+:\s*/, '');
    const a = simhash(body(1))!, b = simhash(body(2))!, c = simhash('A recipe for slow roasted tomatoes with garlic, basil, olive oil, and a long list of other unrelated ingredients.')!;
    expect(hamming(a, a)).toBe(0);
    expect(hamming(a, b)).toBeLessThanOrEqual(3);
    expect(hamming(a, c)).toBeGreaterThan(10);
    expect(simhash('')).toBeNull();
  });

  it('bands find every pair within distance three (pigeonhole)', () => {
    const next = random(7);
    for (let trial = 0; trial < 500; trial++) {
      const base = { hi: Math.floor(next() * 2 ** 32) >>> 0, lo: Math.floor(next() * 2 ** 32) >>> 0 };
      const other = { ...base };
      for (let flip = 0; flip < 3; flip++) {
        const bit = Math.floor(next() * 64);
        if (bit < 32) other.hi = (other.hi ^ (1 << bit)) >>> 0; else other.lo = (other.lo ^ (1 << (bit - 32))) >>> 0;
      }
      expect(hamming(base, other)).toBeLessThanOrEqual(3);
      expect(bands(base).some((band, i) => band === bands(other)[i])).toBe(true);
    }
  });
});

describe('source filter near-duplicates', () => {
  it('turns many near-identical sources from one producer into a review signal, never a removal', () => {
    const { ingest } = setup();
    const source = ingest('digest', DIGEST(1), { origin: 'email', type: 'chat_session' });
    expect(producerKey(source)).toBe('email\u001fhello@launchpad.test');
    const features = sourceFeatures(source);
    expect(classify(source, { ...features, nearDuplicates: 2 }).decision).toBe('keep');
    expect(classify(source, { ...features, nearDuplicates: 3 })).toMatchObject({ decision: 'review', signals: ['Near-duplicate of 3 other sources'] });
    expect(classify(source, { ...features, nearDuplicates: 9 }, { nearDuplicateMinCopies: 0 }).decision).toBe('keep');
  });

  it('counts only live near-duplicates from the same origin and producer during a run', async () => {
    const { db, sdk, ingest, prompts } = setup({ llmEnabled: false });
    for (let day = 1; day <= 4; day++) ingest(`digest-${day}`, DIGEST(day), { origin: 'email', type: 'chat_session' });
    // Same template from a different sender, and unrelated mail from the same sender, do not count.
    ingest('other-sender', DIGEST(5, 'Someone Else <someone@else.test>'), { origin: 'email', type: 'chat_session' });
    const stats = await run(sdk);
    expect(stats).toMatchObject({ scanned: 5, algorithmicRemoved: 0, llmRemoved: 0 });
    const decisions = Object.fromEntries(db.query<{ source_id: string; decision: string; verdict: string }, []>(
      'SELECT source_id,decision,verdict FROM source_filter_decisions').all().map(row => [row.source_id, row]));
    const reviewed = Object.entries(decisions).filter(([, row]) => row.decision === 'review').map(([id]) => id);
    // Exactly one digest saw three earlier copies; it awaits review and nothing was removed.
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0]).toMatch(/^digest-/);
    expect(JSON.parse(decisions[reviewed[0]!]!.verdict).signals).toEqual(['Near-duplicate of 3 other sources']);
    expect(decisions['other-sender']!.decision).toBe('keep');
    expect(db.query('SELECT count(*) n FROM sources').get()).toEqual({ n: 5 });
    expect(prompts).toHaveLength(0);
    expect(db.query('SELECT count(*) n FROM source_filter_simhash').get()).toEqual({ n: 5 });
  });

  it('ignores bodies too short to fingerprint', async () => {
    const { db, sdk, ingest } = setup({ llmEnabled: false });
    for (let i = 0; i < 5; i++) ingest(`thanks-${i}`, `[09:0${i}] Bot <bot@x.test>: Thanks!`, { origin: 'email', type: 'chat_session' });
    await run(sdk);
    expect(db.query("SELECT count(*) n FROM source_filter_decisions WHERE decision='review'").get()).toEqual({ n: 0 });
    expect(db.query('SELECT count(*) n FROM source_filter_simhash').get()).toEqual({ n: 0 });
  });
});
