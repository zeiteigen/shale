import { expect, test } from 'bun:test';
import { sentenceAround, supportedTimestamps, tagTemporal, temporalValue } from '../lib/graph/temporal';
import { validateTemporalEvidence } from '../extensions/knowledge-extractor/temporal-evidence';
import type { ExtractionCheckpoint } from '../extensions/knowledge-extractor/types';

const anchor = Date.parse('2026-10-14T12:00:00Z'); // a Wednesday
const iso = (value: number) => new Date(value).toISOString();
const tag = (text: string) => tagTemporal(text, { anchor });

test('normalises absolute dates in several written forms to UTC midnight with exact quotes', () => {
  for (const text of ['Due October 15, 2026.', 'Due 15 October 2026.', 'Due Oct. 15th', 'Due 10/15/2026', 'Due 15/10/2026', 'Due 2026-10-15', 'Due Thursday, October 15']) {
    const [mention] = tag(text);
    expect(mention).toBeDefined();
    expect(iso(mention!.start)).toBe('2026-10-15T00:00:00.000Z');
    expect(mention!.grain).toBe('day');
    expect(text.slice(mention!.offset, mention!.offset + mention!.quote.length)).toBe(mention!.quote);
  }
  // Ambiguous numeric dates follow the configured order.
  expect(iso(tagTemporal('03/04/2026', { dateOrder: 'dmy' })[0]!.start)).toBe('2026-04-03T00:00:00.000Z');
  expect(iso(tagTemporal('03/04/2026')[0]!.start)).toBe('2026-03-04T00:00:00.000Z');
});

test('converts stated time zones, reads zone-less times as UTC, and marks deadlines from their cue', () => {
  const [deadline] = tag('Applications close Oct 15, 11:59 PM EST.');
  expect(deadline).toMatchObject({ quote: 'Oct 15, 11:59 PM EST', grain: 'minute', kind: 'deadline' });
  expect(iso(deadline!.start)).toBe('2026-10-16T04:59:00.000Z');
  expect(deadline!.floating).toBe(false);
  const [daylight] = tag('Friday, October 16, 2026 at 10:00 AM PDT');
  expect(iso(daylight!.start)).toBe('2026-10-16T17:00:00.000Z');
  // Generic US zones follow daylight saving.
  expect(iso(tag('Jan 15, 2027 at 9am ET')[0]!.start)).toBe('2027-01-15T14:00:00.000Z');
  expect(iso(tag('July 15, 2026 at 9am ET')[0]!.start)).toBe('2026-07-15T13:00:00.000Z');
  expect(iso(tag('Sept 1, 2026 at 17:30 UTC+05:30')[0]!.start)).toBe('2026-09-01T12:00:00.000Z');
  const [floating] = tag('Meet 15 October at 3pm');
  expect(floating).toMatchObject({ floating: true, kind: 'date' });
  expect(iso(floating!.start)).toBe('2026-10-15T15:00:00.000Z');
  expect(tag('Submit by October 20')[0]!.kind).toBe('deadline');
});

test('anchors relative expressions on the source time and refuses them without an anchor', () => {
  const day = (text: string) => iso(tag(text)[0]!.start).slice(0, 10);
  expect(day('see you today')).toBe('2026-10-14');
  expect(day('see you tomorrow')).toBe('2026-10-15');
  expect(day('it was yesterday')).toBe('2026-10-13');
  expect(day('next Friday works')).toBe('2026-10-16');
  expect(day('next Wednesday works')).toBe('2026-10-21');
  expect(day('last Monday')).toBe('2026-10-12');
  expect(day('in 3 days')).toBe('2026-10-17');
  expect(day('in two weeks')).toBe('2026-10-28');
  expect(iso(tag('tomorrow at 5 pm')[0]!.start)).toBe('2026-10-15T17:00:00.000Z');
  const weekend = tag('this weekend')[0]!;
  expect([iso(weekend.start), iso(weekend.end), weekend.kind]).toEqual(['2026-10-17T00:00:00.000Z', '2026-10-18T00:00:00.000Z', 'range']);
  expect(tagTemporal('see you tomorrow')).toEqual([]);
  // Yearless dates need an anchor too, which picks the nearest year.
  expect(tagTemporal('Due Oct 15')).toEqual([]);
  expect(iso(tagTemporal('Due Jan 3', { anchor })[0]!.start)).toBe('2027-01-03T00:00:00.000Z');
});

test('tags date and time ranges', () => {
  const days = tag('The hackathon runs Aug 3 – Aug 5');
  expect(days[0]).toMatchObject({ quote: 'Aug 3 – Aug 5', kind: 'range', grain: 'day' });
  expect([iso(days[0]!.start), iso(days[0]!.end)]).toEqual(['2026-08-03T00:00:00.000Z', '2026-08-05T00:00:00.000Z']);
  const compact = tag('Aug 3-5, 2027 in Boston')[0]!;
  expect([compact.quote, iso(compact.start), iso(compact.end)]).toEqual(['Aug 3-5, 2027', '2027-08-03T00:00:00.000Z', '2027-08-05T00:00:00.000Z']);
  const times = tag('Call 10am - 11am EST on Friday')[0]!;
  expect([times.kind, times.grain, iso(times.start), iso(times.end)]).toEqual(['range', 'minute', '2026-10-16T15:00:00.000Z', '2026-10-16T16:00:00.000Z']);
  const borrowed = tag('Oct 15, 10-11am ET')[0]!;
  expect([iso(borrowed.start), iso(borrowed.end)]).toEqual(['2026-10-15T14:00:00.000Z', '2026-10-15T15:00:00.000Z']);
});

test('keeps year- and month-only grains and ignores words and numbers that only look temporal', () => {
  expect(tag('in 2011 the club started')[0]).toMatchObject({ grain: 'year', quote: '2011' });
  expect(tag('October 2026 cohort')[0]).toMatchObject({ grain: 'month', quote: 'October 2026' });
  expect(supportedTimestamps('First published in 2011', { anchor }).size).toBe(0);
  expect(supportedTimestamps('The October 2026 cohort', { anchor }).size).toBe(0);
  for (const text of ['Version 1.2.3 released', 'Monitor the Sat results', 'may 5 be', 'march on', 'First published 2011'])
    expect(tag(text).filter(mention => mention.grain === 'day' || mention.grain === 'minute')).toEqual([]);
  expect(temporalValue(Date.parse('2026-10-15T04:59:00Z'), 'minute')).toBe('2026-10-15T04:59Z');
  expect(temporalValue(Date.parse('2026-10-15'), 'day')).toBe('2026-10-15');
});

test('sentenceAround returns an exact bounded substring containing the span', () => {
  const text = 'Hello there. Applications close Oct 15, 11:59 PM EST. Good luck!';
  const start = text.indexOf('Oct 15');
  const sentence = sentenceAround(text, start, start + 6);
  expect(sentence.quote).toBe('Applications close Oct 15, 11:59 PM EST.');
  expect(text.slice(sentence.offset, sentence.offset + sentence.quote.length)).toBe(sentence.quote);
  const long = `${'word '.repeat(200)}due Oct 15 ${'more '.repeat(200)}`;
  const bounded = sentenceAround(long, long.indexOf('Oct'), long.indexOf('Oct') + 6, 100);
  expect(bounded.quote.length).toBeLessThanOrEqual(100);
  expect(bounded.quote).toContain('Oct 15');
});

function checkpoint(quote: string, occurredFrom: number, anchorAt?: number): ExtractionCheckpoint {
  return { type: 'knowledge-extraction', revisionId: 1, sourceId: 's', namespace: 'knowledge', chunks: [], anchor: anchorAt,
    extraction: { entities: [], claims: [], events: [{ key: 'e', name: 'E', kind: 'Deadline', occurredFrom, participants: [], evidence: [{ chunkIndex: 0, quote }] }] } };
}

test('validates model timestamps against tagger-normalised quotes at the stated precision', () => {
  expect(() => validateTemporalEvidence(checkpoint('Applications close Oct 15, 2026, 11:59 PM EST', Date.parse('2026-10-16T04:59:00Z')))).not.toThrow();
  // The written calendar day is supported too; an invented time is not.
  expect(() => validateTemporalEvidence(checkpoint('Applications close Oct 15, 2026, 11:59 PM EST', Date.parse('2026-10-15')))).not.toThrow();
  expect(() => validateTemporalEvidence(checkpoint('Applications close Oct 15, 2026', Date.parse('2026-10-15T12:00:00Z')))).toThrow('Unsupported extraction date');
  // Relative and yearless dates need the source's anchor.
  expect(() => validateTemporalEvidence(checkpoint('See you tomorrow', Date.parse('2026-10-15')))).toThrow('Unsupported extraction date');
  expect(() => validateTemporalEvidence(checkpoint('See you tomorrow', Date.parse('2026-10-15'), anchor))).not.toThrow();
  expect(() => validateTemporalEvidence(checkpoint('Due Oct 15', Date.parse('2026-10-15'), anchor))).not.toThrow();
  // Year- and month-only text never supports a day timestamp; ISO quotes keep working.
  expect(() => validateTemporalEvidence(checkpoint('First published in 2011', Date.parse('2011-01-01'), anchor))).toThrow('Unsupported extraction date');
  expect(() => validateTemporalEvidence(checkpoint('Starts October 2026', Date.parse('2026-10-01'), anchor))).toThrow('Unsupported extraction date');
  expect(() => validateTemporalEvidence(checkpoint('Published on 2026-10-07.', Date.parse('2026-10-07')))).not.toThrow();
});
