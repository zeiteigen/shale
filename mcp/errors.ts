/** Stable error categories supplement the existing human-readable MCP error text. */
export function toolErrorDetails(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  let code = 'INTERNAL_ERROR';
  if (/stale .*inspect|knowledge changed during preparation/i.test(message)) code = 'VERSION_CONFLICT';
  else if (/excluded from ingestion|SOURCE_EXCLUDED/i.test(message)) code = 'SOURCE_EXCLUDED';
  else if (/ambiguous|resolves to [2-9]\d* nodes|resolves to 1\d+ nodes/i.test(message)) code = 'AMBIGUOUS_REFERENCE';
  else if (/unknown |not found|does not exist|is absent|no matching entity|resolves to 0 nodes/i.test(message)) code = 'NOT_FOUND';
  else if (/request id already used/i.test(message)) code = 'REQUEST_ID_CONFLICT';
  else if (/already exists|already belongs|already live|UNIQUE constraint/i.test(message)) code = 'IDENTITY_CONFLICT';
  else if (/SQLITE_|database is locked|disk I\/O/i.test(message)) code = 'DATABASE_ERROR';
  else if (error instanceof Error && error.name === 'ZodError' || /requires?|must |cannot |invalid |provide |cycle|assigned|unmerge|unsupported|exceeds|retain|replacement|not a connection/i.test(message)) code = 'VALIDATION_ERROR';
  return { code, message, retryable: code === 'VERSION_CONFLICT' };
}
