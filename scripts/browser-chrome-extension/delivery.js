import { outboxItems, updateItems } from "./outbox.js";
import { settings, connectorUrl } from "./settings.js";
let running;
export async function fetchWithTimeout(url, options = {}) {
  const config = await settings();
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(
      Math.max(1000, Math.min(20000, config.requestTimeoutMs)),
    ),
  });
}
export async function checkConnection() {
  const config = await settings();
  const response = await fetchWithTimeout(
    new URL("/health", config.serverUrl).href,
  );
  if (!response.ok) throw new Error(`Host returned HTTP ${response.status}`);
  const health = await response.json();
  if (health.service !== "shale")
    throw new Error("Endpoint is not a Shale server");
  if (
    !health.processors?.some(
      (p) =>
        p.name === "browser" && p.durable && p.protocolVersions?.includes(1),
    )
  )
    throw new Error("Browser connector/protocol is not available");
  const policyResponse = await fetchWithTimeout(
    connectorUrl(config.serverUrl, "policy"),
  );
  if (!policyResponse.ok) throw new Error("Browser policy unavailable");
  const policy = await policyResponse.json();
  const saved = await chrome.storage.local.get("capturePolicies");
  await chrome.storage.local.set({
    capturePolicies: {
      ...(saved.capturePolicies || {}),
      [config.serverUrl]: policy,
    },
    lastConnectionError: "",
  });
  return { success: true, status: response.status };
}
async function sendBatch() {
  const rows = await outboxItems(),
    due = rows
      .filter((x) => x.state === "pending" && x.nextAttemptAt <= Date.now())
      .sort((a, b) => a.createdAt - b.createdAt);
  if (!due.length) return;
  const first = due[0];
  const selected = [];
  let bytes = 0;
  for (const row of due.filter(
    (x) => x.endpoint === first.endpoint && x.collectorId === first.collectorId,
  )) {
    if (
      selected.length >= 50 ||
      (selected.length && bytes + row.bytes > 500000)
    )
      break;
    selected.push(row);
    bytes += row.bytes;
  }
  const batchId = selected[0].batchId || crypto.randomUUID();
  await updateItems(
    selected.map((x) => x.id),
    (x) => ({ ...x, batchId }),
  );
  try {
    const payload = {
      type: "browser_batch",
      protocolVersion: 1,
      collectorId: first.collectorId,
      batchId,
      records: selected.map((x) => x.record),
    };
    const response = await fetchWithTimeout(first.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target_processor: "browser",
        content: JSON.stringify(payload),
        metadata: {
          connector: "chrome-extension",
          data_origin: "chrome",
          time: Date.now(),
        },
      }),
    });
    const result = await response
      .json()
      .catch(() => ({ error: `HTTP ${response.status}` }));
    if (!response.ok) {
      const error = new Error(result.error || `HTTP ${response.status}`);
      error.permanent =
        response.status >= 400 &&
        response.status < 500 &&
        ![408, 429].includes(response.status);
      error.retryAfter = Number(response.headers.get("retry-after")) * 1000;
      throw error;
    }
    if (
      result.protocolVersion !== 1 ||
      result.collectorId !== first.collectorId ||
      result.batchId !== batchId ||
      !Array.isArray(result.records) ||
      result.records.length !== selected.length ||
      selected.some(
        (row) =>
          !result.records.some(
            (receipt) =>
              receipt.recordId === row.id &&
              typeof receipt.jobId === "string" &&
              ["received", "duplicate", "skipped"].includes(receipt.status),
          ),
      )
    )
      throw new Error("Invalid durable receipt from server");
    await updateItems(
      selected.map((x) => x.id),
      (item) => {
        const receipt = result.records.find((x) => x.recordId === item.id);
        return {
          ...item,
          jobId: receipt.jobId,
          state: receipt.status === "skipped" ? "skipped" : "received",
          record:
            receipt.status === "skipped" ? { recordId: item.id } : item.record,
          error: receipt.reason || "",
          updatedAt: Date.now(),
        };
      },
    );
    await chrome.storage.local.set({ lastSyncTime: Date.now() });
  } catch (error) {
    await updateItems(
      selected.map((x) => x.id),
      (item) => ({
        ...item,
        state: error.permanent ? "failed" : "pending",
        attempts: item.attempts + 1,
        error: error.message,
        updatedAt: Date.now(),
        nextAttemptAt:
          Date.now() +
          Math.max(
            error.retryAfter || 0,
            Math.min(3600000, 1000 * 2 ** Math.min(12, item.attempts + 1)) *
              (0.75 + Math.random() * 0.5),
          ),
      }),
    );
  }
}
async function pollReceipts() {
  const rows = (await outboxItems())
    .filter((x) => x.state === "received")
    .slice(0, 100);
  if (!rows.length) return;
  for (const endpoint of new Set(rows.map((x) => x.endpoint))) {
    const group = rows.filter((x) => x.endpoint === endpoint);
    try {
      const url = new URL(connectorUrl(endpoint, "status"));
      url.searchParams.set("ids", group.map((x) => x.jobId).join(","));
      const response = await fetchWithTimeout(url.href);
      if (!response.ok) continue;
      const result = await response.json();
      await updateItems(
        group.map((x) => x.id),
        (item) => {
          const receipt = result.records?.find((x) => x.jobId === item.jobId);
          if (!receipt) return item;
          const state = ["indexed", "skipped", "failed"].includes(
            receipt.status,
          )
            ? receipt.status
            : "received";
          return {
            ...item,
            state,
            record: ["indexed", "skipped"].includes(state)
              ? { recordId: item.id }
              : item.record,
            error: receipt.reason || "",
            updatedAt: Date.now(),
          };
        },
      );
    } catch {
      /* Durable receipts remain pending when the status endpoint is unavailable. */
    }
  }
}
export function deliverOutbox() {
  return (running ??= (async () => {
    await sendBatch();
    await pollReceipts();
  })().finally(() => {
    running = undefined;
  }));
}
export async function retryFailures() {
  const rows = (await outboxItems()).filter((x) => x.state === "failed");
  for (const endpoint of new Set(
    rows.filter((x) => x.jobId).map((x) => x.endpoint),
  )) {
    const ids = rows
      .filter((x) => x.endpoint === endpoint && x.jobId)
      .map((x) => x.jobId);
    for (let start = 0; start < ids.length; start += 100) {
      const response = await fetchWithTimeout(connectorUrl(endpoint, "retry"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ids.slice(start, start + 100) }),
      });
      if (!response.ok) throw new Error("Could not retry server processing");
    }
  }
  await updateItems(
    rows.map((x) => x.id),
    (item) => ({
      ...item,
      state: item.jobId ? "received" : "pending",
      attempts: 0,
      nextAttemptAt: 0,
      error: "",
    }),
  );
}
