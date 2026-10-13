import { expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDatabase } from './fixtures/database';
import { holdDatabaseWriter } from './fixtures/held-writer';
import { createExtensionSDK } from '../sdk';
import { configureDatabaseConnection } from '../lib/database-connection';
import { emailConnector } from '../extensions/email/connector';
import { pendingWindows } from '../sdk/chat/windows';
import { prepareWindow, recoverChatWindows } from '../sdk/chat/commit';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'shale-chat-writer-')), path = join(directory, 'graph.db');
  const db = createTestDatabase(path); configureDatabaseConnection(db);
  const sdk = createExtensionSDK('email', { database: db });
  return { path, db, sdk, close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

it('ingests a source after another local writer releases the database', async () => {
  const f = fixture(), writer = await holdDatabaseWriter(f.path);
  try {
    const result = f.sdk.ingest.sourceAndChunks({ source: { id: 'source', uri: 'test://source', title: 'Guide', origin: 'test', type: 'note' },
      chunks: [{ text_content: 'A guide to SQLite.' }] });
    expect(await writer.exited).toBe(0);
    expect(result.sourceId).toBe('source');
    expect(f.sdk.context.getSource('source')).not.toBeNull();
  } finally { await writer.close(); f.close(); }
});

it('recovers a prepared email window without another model call during a concurrent write', async () => {
  const f = fixture();
  let writer: Awaited<ReturnType<typeof holdDatabaseWriter>> | undefined;
  try {
    const connector = emailConnector(f.sdk);
    connector.store.ingest({ conversationId: 'mail', title: 'Project update', kind: 'dm', uri: 'email://mail' },
      [{ messageId: 'one', authorId: 'sender@example.test', authorName: 'Sender', sentAt: 1,
        text: 'The project update is ready.', attachments: [] }]);
    const window = pendingWindows(connector.store, 'email', { summarize: false })[0];
    expect(await prepareWindow(f.sdk, connector, window, { summarize: false })).not.toBeNull();
    let calls = 0;
    f.sdk.queryLLM = (async () => { calls++; throw new Error('Recovery must use its checkpoint'); }) as unknown as typeof f.sdk.queryLLM;
    writer = await holdDatabaseWriter(f.path);
    const result = await recoverChatWindows(f.sdk, connector, f.sdk.getCheckpointContext());
    expect(await writer.exited).toBe(0);
    expect(result).toMatchObject({ recoveredWindows: 1 });
    expect(calls).toBe(0);
    expect(f.sdk.hasCheckpoints()).toBe(false);
  } finally { await writer?.close(); f.close(); }
});
