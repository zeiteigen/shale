import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExtensionSDK } from '../sdk';
import { createTestDatabase } from './fixtures/database';

it('audits support by source freshness across memory edits and actual source changes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'shale-graph-audit-'));
  const path = join(directory, 'graph.db');
  const db = createTestDatabase(path);
  try {
    const sdk = createExtensionSDK('audit-test', { database: db });
    const source = { id: 'guide', title: 'Guide', uri: 'test://guide', origin: 'test', type: 'note' };
    sdk.ingest.sourceAndChunks({ source, chunks: [{ text_content: 'The radius is positive.' }] });
    const entity = sdk.graph.entities.create({ name: 'Radius', type: 'Concept' });
    const claim = sdk.graph.claims.add({ subject: entity.id, predicate: 'DESCRIPTION', value: 'positive',
      status: 'accepted', method: 'connector', evidence: [{ sourceId: source.id, chunkIndex: 1, quote: 'radius is positive' }] });
    const audit = () => {
      const result = Bun.spawnSync([process.execPath, join(import.meta.dir, '../scripts/audit-graph.ts'), path]);
      expect(result.stderr.toString()).toBe('');
      return { exitCode: result.exitCode, ...JSON.parse(result.stdout.toString()) };
    };
    expect(audit()).toMatchObject({ exitCode: 0, issues: {} });
    sdk.memory.edit({ sourceId: source.id, expectedVersion: 1, actor: 'test', reason: 'Improve synopsis',
      summary: 'A radius describes distance.' });
    expect(audit()).toMatchObject({ exitCode: 0, issues: {} });

    sdk.ingest.sourceAndChunks({ source, chunks: [{ text_content: 'The radius can now be signed.' }] });
    // Simulate a corrupted live status: the audit must still flag real source changes.
    db.query("UPDATE graph_claims SET status='accepted' WHERE id=?").run(claim.id);
    expect(audit()).toMatchObject({ exitCode: 1, issues: { liveClaimsWithStaleSupport: 1 } });
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
