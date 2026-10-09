import { expect, it } from 'bun:test';
import { formatToolError } from '../mcp/types';

it('provides distinct machine-readable editing errors while preserving error text', () => {
  const cases = [
    ['Unknown live source: missing', 'NOT_FOUND'],
    ['Entity Ada resolves to 12 nodes; specify an ID', 'AMBIGUOUS_REFERENCE'],
    ['Stale entity 1; inspect it again before editing', 'VERSION_CONFLICT'],
    ['Knowledge changed during preparation; inspect and retry the batch', 'VERSION_CONFLICT'],
    ['Source is excluded from ingestion: spam', 'SOURCE_EXCLUDED'],
    ['Request ID already used for a different change', 'REQUEST_ID_CONFLICT'],
    ['Source URI already belongs to another source: test://other', 'IDENTITY_CONFLICT'],
    ['Dependency would create a cycle', 'VALIDATION_ERROR'],
  ];
  for (const [message, code] of cases) {
    const result = formatToolError(new Error(message));
    expect(result.isError).toBe(true);
    expect(result.structuredContent.error.code).toBe(code);
    expect(result.structuredContent.error.retryable).toBe(code === 'VERSION_CONFLICT');
    expect(result.content[0].text).toBe(`Error: ${message}`);
  }
});
