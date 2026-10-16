import { afterEach, describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createExtensionSDK } from '../sdk';
import { createTestDatabase } from './fixtures/database';
import { PATTERN_STATE_KEY } from '../lib/graph/patterns';
import { indexEntity } from '../sdk/graph/registry';
import { reasonPatterns } from '../extensions/knowledge-graph/reason';

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const CURSOR = 'reasoner-pattern-cursor';

function fixture() {
  const db = createTestDatabase(); databases.push(db);
  const sdk = createExtensionSDK('knowledge-graph', { database: db, namespace: 'knowledge' });
  const from = sdk.graph.entities.create({ name: 'Ada Byron', type: 'Person' }).id;
  const to = sdk.graph.entities.create({ name: 'Grace Hopper', type: 'Person' }).id;
  indexEntity(db, from); indexEntity(db, to);
  sdk.state.setJson(PATTERN_STATE_KEY, { version: 1, learnedAt: Date.now(), patterns: [
    { id: 'test', predicate: 'SENT_TO', order: 'so', left: [], middle: ['<', '<email>', '>', 'to', ':'], right: [], support: 5, precision: 1, evaluated: 8 },
  ] });
  const digest = (id: string, at = 1000, version = 1) => {
    sdk.ingest.sourceAndChunks({ source: { id, uri: `mail://${id}`, title: id, origin: 'email', type: 'email', hash: `${id}-v${version}` },
      chunks: [{ text_content: `From: Ada Byron <ada@example.org>\nTo: Grace Hopper <grace@example.com>\n\nHello ${version}.` }] });
    const revision = db.query<{ id: number }, [string]>(
      'SELECT r.id FROM graph_source_revisions r JOIN sources s ON s.id=r.source_id AND s.hash=r.hash WHERE s.id=?').get(id)!.id;
    db.query(`INSERT INTO graph_source_digests(source_id,revision_id,digested_at) VALUES(?,?,?)
      ON CONFLICT(source_id) DO UPDATE SET revision_id=excluded.revision_id,digested_at=excluded.digested_at`).run(id, revision, at);
    return revision;
  };
  return { db, sdk, from, to, digest };
}

describe('pattern reasoner recovery', () => {
  it('processes tied digest timestamps across batches exactly once', async () => {
    const { sdk, digest } = fixture();
    for (const id of ['c', 'a', 'b']) digest(id);
    expect(await reasonPatterns(sdk, 'active', { patternSourcesPerRun: 2 })).toMatchObject({ sources: 2, written: 2 });
    expect(await reasonPatterns(sdk, 'active', { patternSourcesPerRun: 2 })).toMatchObject({ sources: 1, written: 1 });
    expect(await reasonPatterns(sdk, 'active', {})).toMatchObject({ sources: 0, written: 0 });
  });

  it('replays a legacy timestamp boundary to recover skipped ties', async () => {
    const { sdk, digest } = fixture();
    digest('a'); digest('b');
    sdk.state.set(CURSOR, '1000');
    expect(await reasonPatterns(sdk, 'active', {})).toMatchObject({ sources: 2, written: 2 });
  });

  it('rolls back a failed source and resumes within tied timestamps', async () => {
    const { db, sdk, digest } = fixture();
    digest('a'); digest('b'); digest('c');
    db.run(`CREATE TRIGGER fail_second BEFORE UPDATE ON extension_state
      WHEN NEW.state_key='reasoner-pattern-cursor' AND json_extract(NEW.value,'$.sourceId')='b'
      BEGIN SELECT RAISE(ABORT,'interrupted'); END`);
    await expect(reasonPatterns(sdk, 'active', {})).rejects.toThrow('interrupted');
    expect(db.query("SELECT count(*) AS n FROM graph_claims WHERE method='pattern'").get()).toEqual({ n: 1 });
    db.run('DROP TRIGGER fail_second');
    expect(await reasonPatterns(sdk, 'active', {})).toMatchObject({ sources: 2, written: 2 });
  });

  it('creates current evidence after a refresh and preserves reviews on replay', async () => {
    const { db, sdk, digest, from, to } = fixture();
    const oldRevision = digest('a');
    expect(await reasonPatterns(sdk, 'active', {})).toMatchObject({ written: 1 });
    const old = db.query<{ id: string }, []>("SELECT id FROM graph_claims WHERE method='pattern'").get()!.id;
    const revision = digest('a', 2000, 2);
    expect(revision).not.toBe(oldRevision);
    expect(sdk.graph.claims.get(old).status).toBe('stale');
    expect(await reasonPatterns(sdk, 'active', {})).toMatchObject({ written: 1 });
    const current = db.query<{ id: string }, [string]>("SELECT id FROM graph_claims WHERE method='pattern' AND id<>?").get(old)!.id;
    expect(sdk.graph.claims.get(current)).toMatchObject({ subject: from, predicate: 'SENT_TO', object: to, status: 'proposed' });
    expect(db.query('SELECT revision_id FROM graph_evidence WHERE claim_id=?').all(current)).toEqual([{ revision_id: revision }]);
    sdk.graph.lifecycle.review(current, 'rejected', 'test', 'manual rejection');
    sdk.state.delete(CURSOR);
    expect(await reasonPatterns(sdk, 'active', {})).toMatchObject({ written: 0 });
    expect(sdk.graph.claims.get(current).status).toBe('rejected');
  });
});
