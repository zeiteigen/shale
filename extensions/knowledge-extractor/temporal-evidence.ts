import type { ExtractionCheckpoint } from './types';
import { supportedTimestamps } from '../../lib/graph/temporal';

/**
 * Model-computed epoch values must match an explicit date at the quoted precision: an ISO date or timestamp in the
 * quote, or a day/minute expression the temporal tagger normalises to exactly that value ("Oct 15, 11:59 PM EST",
 * "tomorrow" relative to the source's time). Year- and month-only text never supports a day timestamp.
 */
export function validateTemporalEvidence(data: ExtractionCheckpoint) {
  for (const item of [...data.extraction.claims,...data.extraction.events]) {
    for (const field of ['validFrom','validTo','observedAt','occurredFrom','occurredTo'] as const) {
      const value = (item as Partial<Record<typeof field,number>>)[field];
      if (value === undefined) continue;
      if (!Number.isSafeInteger(value) || Math.abs(value)>8.64e15) throw new Error(`Invalid extraction date ${field}`);
      const iso = new Date(value).toISOString();
      const forms = [iso];
      if (value % 1000 === 0) forms.push(iso.replace('.000Z','Z'));
      const exact = item.evidence.some(evidence => forms.some(form=>evidence.quote.includes(form)));
      const day = iso.slice(0,10);
      const calendarDate = value % 86400000 === 0 && item.evidence.some(evidence =>
        new RegExp(`(?<![\\d-])${day}(?![\\dT-])`).test(evidence.quote));
      const tagged = !exact && !calendarDate && item.evidence.some(evidence =>
        supportedTimestamps(evidence.quote, { anchor: data.anchor }).has(value));
      if (!exact && !calendarDate && !tagged)
        throw new Error(`Unsupported extraction date ${field}: ${iso}. Use timestamps only for dates/times stated in cited quotes, at the stated precision; otherwise omit the timestamp and preserve the stated year or date as text.`);
    }
  }
}
