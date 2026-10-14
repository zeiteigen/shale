import { afterEach, describe, expect, it } from 'bun:test';
import { classify } from '../extensions/source-filter/rules';
import { sourceFeatures } from '../extensions/source-filter/features';
import { parseArguments } from '../extensions/source-filter/cli';
import { filterFixture, SPAM } from './fixtures/source-filter';

const fixtures: ReturnType<typeof filterFixture>[] = [];
const setup = () => { const fixture = filterFixture(); fixtures.push(fixture); return fixture; };
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

describe('source filter deterministic triage', () => {
  it('removes complete error/login/challenge captures without treating diagnostic material as empty', () => {
    const { ingest } = setup();
    for (const [id, text] of [['error', '404 Not Found'], ['login', 'Sign in\nEmail\nPassword'],
      ['captcha', 'Verify you are human\nContinue']])
      expect(classify(ingest(id!, text!))).toMatchObject({ decision: 'remove', category: 'capture_failure', method: 'algorithm' });
    expect(classify(ingest('diagnostic', 'Access denied\nTraceback: the certificate expired at 2026-01-01.'))).toMatchObject({ decision: 'keep' });
    expect(classify(ingest('tutorial', 'How to repair a 404\nReturn a 404 response when a resource is absent.'))).toMatchObject({ decision: 'keep' });
  });

  it('keeps short, non-English, code, attachment, and meaningful metadata records', () => {
    const { ingest } = setup();
    for (const [id, text, type] of [['brief', 'Meet at 3.', 'chat_session'], ['language', '明日の会議は午後三時です。', 'chat_session'],
      ['code', 'const result = await fetch(url);', 'web_page'], ['attachment', '[image: budget-chart.png]', 'chat_session'],
      ['search', 'Searched Google for "sqlite". No results were opened.', 'web_search'],
      ['history', 'Title: Database tutorial\nURL: https://example.test/sqlite\nVisit count: 1', 'browser_history'],
      ['video', 'Title: A useful lecture\nURL: https://youtube.com/watch?v=123', 'youtube_video']])
      expect(classify(ingest(id!, text!, { type }))).toMatchObject({ decision: 'keep' });
    const missing = ingest('metadata-page', 'Original capture', { quality: 'metadata' });
    missing.memory!.snippets = [];
    expect(classify(missing).decision).toBe('keep');
  });

  it('routes promotional, repetitive, link-heavy, and boilerplate content to review', () => {
    const { ingest } = setup();
    for (const [id, text] of [['promotion', SPAM], ['repetition', Array(10).fill('Follow our channel').join('\n')],
      ['links', Array.from({ length: 6 }, (_, index) => `https://example.test/${index}`).join('\n')],
      ['boilerplate', 'Home\nMenu\nSearch\nPrivacy policy\nTerms of use']])
      expect(classify(ingest(id!, text!)).decision).toBe('review');
    expect(classify(ingest('newsletter', 'This week we explain database migrations.\nUnsubscribe')).decision).toBe('keep');
    expect(classify(ingest('receipt', 'Subject: Receipt\nFrom: Store\nOrder 246 paid $36. Delivery Friday.')).decision).toBe('keep');
  });

  it('does not interpret a sampled shell or a generated summary as the full source', () => {
    const { ingest } = setup();
    const sampled = ingest('sample', 'Sign in\nPassword');
    sampled.memory!.coverage.inputCharacters = 50_000;
    expect(classify(sampled).decision).toBe('review');
    sampled.memory!.summary.text = SPAM;
    expect(sourceFeatures(sampled).promotionCues).toBe(0);
  });

  it('accepts only the supported preview and source-selection arguments', () => {
    expect(parseArguments(['--dry-run', '--source', 'a', '--source', 'b'])).toEqual({ dryRun: true, sourceIds: ['a', 'b'] });
    expect(() => parseArguments(['--source'])).toThrow('incomplete');
    expect(() => parseArguments(['--force'])).toThrow('Unknown');
  });
});
