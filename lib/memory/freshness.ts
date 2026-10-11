/** A memory edit does not pretend the original source changed. Legacy revisions fall back to hashes. */
export function currentRevisionSQL(alias = 'r'): string {
  return `EXISTS(SELECT 1 FROM sources s LEFT JOIN source_memories m ON m.source_id=s.id
    LEFT JOIN source_revision_fingerprints f ON f.revision_id=${alias}.id
    WHERE s.id=${alias}.source_id AND CASE WHEN f.fingerprint IS NOT NULL AND m.fingerprint IS NOT NULL
      THEN f.fingerprint=m.fingerprint ELSE s.hash=${alias}.hash END)`;
}
