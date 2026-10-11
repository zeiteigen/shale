import { validateBrowserPayload } from "./protocol.js";
let connection;
const request = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
function database() {
  return (connection ??= new Promise((resolve, reject) => {
    const req = indexedDB.open("shale-browser-v1", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      const outbox = db.createObjectStore("outbox", { keyPath: "id" });
      outbox.createIndex("state", "state");
      db.createObjectStore("imports", { keyPath: "id" });
      db.createObjectStore("meta", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}
export async function transaction(stores, mode, work) {
  const db = await database();
  const tx = db.transaction(stores, mode);
  const finished = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () =>
      reject(tx.error || new Error("Browser storage transaction aborted"));
  });
  try {
    const result = await work(tx);
    await finished;
    return result;
  } catch (error) {
    try {
      tx.abort();
    } catch {}
    await finished.catch(() => {});
    throw error;
  }
}
export const getRequest = request;
export async function nextSequence() {
  return transaction(["meta"], "readwrite", async (tx) => {
    const store = tx.objectStore("meta");
    const old = await request(store.get("sequence"));
    const value = (old?.value || 0) + 1;
    store.put({ id: "sequence", value });
    return value;
  });
}
export async function enqueueRecords(records, config) {
  const batch = {
    type: "browser_batch",
    protocolVersion: 1,
    collectorId: config.collectorId,
    batchId: "validation",
    records,
  };
  validateBrowserPayload(batch);
  return transaction(["outbox", "meta"], "readwrite", async (tx) => {
    const store = tx.objectStore("outbox");
    const current = await request(store.getAll());
    let pending = current.filter((x) =>
      ["pending", "received", "failed"].includes(x.state),
    );
    let bytes = pending.reduce((total, x) => total + x.bytes, 0);
    for (const record of records) {
      const existing = await request(store.get(record.recordId));
      if (existing) {
        if (
          existing.record?.type &&
          JSON.stringify(existing.record) !== JSON.stringify(record)
        )
          throw new Error("Capture ID was reused with different content");
        continue;
      }
      const size = new TextEncoder().encode(JSON.stringify(record)).length;
      if (pending.length >= 10000 || bytes + size > 50000000)
        throw new Error(
          "Local capture queue is full. Resume delivery before importing more.",
        );
      const item = {
        id: record.recordId,
        record,
        bytes: size,
        endpoint: config.serverUrl,
        collectorId: config.collectorId,
        state: "pending",
        createdAt: Date.now(),
        attempts: 0,
        nextAttemptAt: 0,
      };
      store.add(item);
      pending.push(item);
      bytes += size;
    }
    // Preserve recent receipts; pruning does not change durable lifetime counters.
    const terminal = current
      .filter((x) => ["indexed", "skipped", "expired"].includes(x.state))
      .sort((a, b) => b.createdAt - a.createdAt);
    for (const old of terminal.slice(1000)) store.delete(old.id);
  });
}
export async function outboxItems() {
  const now = Date.now();
  return transaction(["outbox"], "readwrite", async (tx) => {
    const store = tx.objectStore("outbox");
    const rows = await request(store.getAll());
    for (const item of rows) {
      if (!["pending", "received", "failed"].includes(item.state) || now - item.createdAt < 86400000) continue;
      const error = "Capture expired after 24 hours without terminal indexing; resubmit to retry";
      store.put({ ...item, state: "expired", record: { recordId: item.id }, bytes: 0, error, updatedAt: now });
      item.state = "expired";
      item.record = { recordId: item.id };
      item.bytes = 0;
      item.error = error;
    }
    return rows;
  });
}
export async function hasRecord(id) {
  return transaction(["outbox"], "readonly", (tx) =>
    request(tx.objectStore("outbox").get(id)),
  );
}
export async function updateItems(ids, update) {
  return transaction(["outbox", "meta"], "readwrite", async (tx) => {
    const store = tx.objectStore("outbox");
    for (const id of ids) {
      const item = await request(store.get(id));
      if (!item) continue;
      const next = update(item);
      store.put(next);
      if (item.state === "pending" && next.state === "received") {
        const meta = tx.objectStore("meta"),
          old = await request(meta.get("sent"));
        meta.put({ id: "sent", value: (old?.value || 0) + 1 });
      }
    }
  });
}
export async function importJobs() {
  return transaction(["imports"], "readonly", (tx) =>
    request(tx.objectStore("imports").getAll()),
  );
}
export async function saveImport(job) {
  return transaction(["imports"], "readwrite", (tx) =>
    request(tx.objectStore("imports").put({ ...job, updatedAt: Date.now() })),
  );
}
export async function outboxSummary() {
  const rows = await outboxItems();
  const counts = rows.reduce((out, row) => {
    out[row.state] = (out[row.state] || 0) + 1;
    return out;
  }, {});
  const sent = await transaction(["meta"], "readonly", (tx) =>
    request(tx.objectStore("meta").get("sent")),
  );
  const pending = rows.filter((row) => row.state === "pending");
  return {
    counts,
    sentCount: sent?.value || 0,
    oldestUnsentAgeMs: pending.length
      ? Date.now() - Math.min(...pending.map((row) => row.createdAt))
      : 0,
    lastError:
      rows
        .filter((x) => x.error)
        .sort(
          (a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt),
        )[0]?.error || "",
    failures: rows
      .filter((x) => x.state === "failed")
      .map((x) => ({ id: x.id, error: x.error }))
      .slice(0, 20),
    expired: rows
      .filter((x) => x.state === "expired")
      .map((x) => ({ id: x.id, error: x.error }))
      .slice(0, 20),
  };
}
