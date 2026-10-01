import { randomUUIDv7 } from 'bun';
import type { Database } from 'bun:sqlite';

/** Persistent ownership for bounded jobs; a crashed owner expires automatically. */
export function acquireTaskLease(db: Database, extensionId: string, key: string, ttl = 900_000) {
  const token=randomUUIDv7();
  const now=Date.now();
  const owned=db.query(`INSERT INTO extension_state(extension_id,state_key,value,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(extension_id,state_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
    WHERE extension_state.updated_at<=? RETURNING value`).get(extensionId,key,token,now,now-ttl);
  if (!owned) return null;
  return {
    renew() {
      if (db.query('UPDATE extension_state SET updated_at=? WHERE extension_id=? AND state_key=? AND value=?')
        .run(Date.now(),extensionId,key,token).changes!==1) throw new Error('Task lease was lost');
    },
    release() {db.query('DELETE FROM extension_state WHERE extension_id=? AND state_key=? AND value=?').run(extensionId,key,token);},
  };
}
