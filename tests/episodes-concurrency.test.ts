import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase } from './fixtures/database';
import { createExtensionSDK } from '../sdk';
import { configureDatabaseConnection } from '../lib/database-connection';
import { EpisodeStore } from '../sdk/graph/episodes';
import { Assigner, DEFAULTS, pendingDigests } from '../extensions/episodes/assign';
import { holdDatabaseWriter } from './fixtures/held-writer';

it('waits for another local writer before atomically committing episode assignment', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'shale-episode-writer-'));
  const path = join(directory, 'graph.db'), db = createTestDatabase(path);
  configureDatabaseConnection(db);
  const sdk = createExtensionSDK('episodes', { database: db });
  const store = new EpisodeStore(db, sdk.graph);
  const episode = store.create({ title: 'Onboarding', kind: 'application', at: 1 });
  const org = sdk.graph.entities.create({ name: 'Club', type: 'Organization' }).id;
  sdk.ingest.sourceAndChunks({ source: { id: 'application', title: 'Application', uri: 'test://application', origin: 'test', type: 'note' },
    chunks: [{ text_content: 'Applied to the club.' }] });
  db.query(`INSERT INTO graph_source_digests(source_id,revision_id,digested_at,involvement,entity_ids)
    SELECT 'application',id,1,'participant',? FROM graph_source_revisions WHERE source_id='application'`)
    .run(JSON.stringify([org]));
  const pending = { digest: pendingDigests(sdk, 1)[0], activity: null, signals: new Map([[org, 1]]), candidates: [] };
  const writer = await holdDatabaseWriter(path);
  try {
    // The trigger defines the episode, so its entities become the episode's hooks in the same transaction.
    new Assigner(sdk, DEFAULTS).attach(episode, pending, 'accepted', 1, 'Observed application', true);
    expect(await writer.exited).toBe(0);
    expect(store.isMember(episode, 'application')).toBe(true);
    expect(store.involved(episode).map(entity => entity.id)).toEqual([org]);
    expect(db.query("SELECT episode_state FROM graph_source_digests WHERE source_id='application'").get())
      .toEqual({ episode_state: 'assigned' });
  } finally {
    await writer.close(); db.close(); rmSync(directory, { recursive: true, force: true });
  }
});
