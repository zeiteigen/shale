import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExtensionSDK } from '../sdk';
import { EpisodeStore } from '../sdk/graph/episodes';
import { createTestDatabase } from './fixtures/database';

it('evaluates a cross-source story after multiple episode merges', () => {
  const directory = mkdtempSync(join(tmpdir(), 'shale-graph-eval-'));
  const path = join(directory, 'graph.db'), threads = join(directory, 'threads.json');
  const db = createTestDatabase(path);
  try {
    const sdk = createExtensionSDK('episodes', { database: db });
    const store = new EpisodeStore(db, sdk.graph);
    const episodes: number[] = [];
    for (const origin of ['discord', 'browser', 'email']) {
      sdk.ingest.sourceAndChunks({ source: { id: origin, title: origin, origin, type: 'note', uri: `test://${origin}` },
        chunks: [{ text_content: 'Onboarding and interview evidence.' }] });
      const episode = store.create({ title: `Onboarding ${origin}`, kind: 'application', at: 1 });
      store.attach(episode, origin, { role: 'progress', step: 'Onboarding', at: 1, confidence: 1,
        status: 'accepted', basis: 'Fixture evidence' });
      episodes.push(episode);
    }
    store.merge(episodes[0], episodes[1], 'Same pursuit');
    store.merge(episodes[1], episodes[2], 'Same pursuit');
    writeFileSync(threads, JSON.stringify({ threads: [{ name: 'Onboarding to interview', members:
      ['discord', 'browser', 'email'].map(origin => ({ label: origin, origin })) }] }));
    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, '../scripts/graph-eval.ts'), path, '--threads', threads, '--json']);
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout.toString());
    expect(report.threads[0].connected).toBe(true);
    expect(report.threads[0].episodes.map((episode: { id: number }) => episode.id)).toEqual([episodes[2]]);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});
