import type { ExtractionCheckpoint } from './types';

/** Model-computed epoch values must match an explicit date at the quoted precision. */
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
      if (!exact && !calendarDate)
        throw new Error(`Unsupported extraction date ${field}: ${iso}. Use timestamps only for exact ISO calendar dates/times in cited quotes; otherwise omit the timestamp and preserve the stated year or date as text.`);
    }
  }
}
