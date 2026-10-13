/** A real second process holds SQLite's writer briefly while the test connection can still read WAL. */
export async function holdDatabaseWriter(path: string) {
  const child = Bun.spawn([process.execPath, '-e', `
    import { Database } from 'bun:sqlite';
    const db = new Database(process.env.SHALE_TEST_WRITER_DB);
    db.run('BEGIN IMMEDIATE');
    process.stdout.write('ready');
    setTimeout(() => { db.run('COMMIT'); db.close(); }, 200);
  `], { env: { ...process.env, SHALE_TEST_WRITER_DB: path }, stdout: 'pipe', stderr: 'pipe' });
  const close = async () => { if (child.exitCode === null) child.kill(); await child.exited; };
  const reader = child.stdout.getReader();
  const ready = await reader.read();
  if (new TextDecoder().decode(ready.value) !== 'ready') {
    await close();
    throw new Error(`SQLite writer failed: ${await new Response(child.stderr).text()}`);
  }
  return { exited: child.exited, close };
}
