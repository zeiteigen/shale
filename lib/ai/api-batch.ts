import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createOpenAIClient } from "./client";
import { resolveApiKey, resolveTimeout, type ModelRole } from "./config";
import { resolveBatchEndpoint, resolveBatchTimeout, resolveBatchPollInterval } from "./batch-config";
import { parseBatchOutput } from "./batch-output";
import { batchProgress } from "./batch-progress";
import type { AIClientOptions } from "./types";
import { executeDirectChatBatch } from "./direct-chat-batch";

/** Upload JSONL, submit, poll, and read ordered responses from an OpenAI-style Batch API. */
export async function executeAPIBatch<T>(role: ModelRole, bodies: unknown[], options?: AIClientOptions): Promise<T[]> {
  if (!bodies.length) return [];
  if (bodies.length > 50_000) throw new Error("Batch API supports at most 50,000 requests per batch");
  const endpoint = resolveBatchEndpoint(role, options);
  if (new URL(endpoint).pathname.endsWith("/chat/completions/batch"))
    return executeDirectChatBatch<T>(endpoint, bodies, options);
  const root = new URL(endpoint);
  root.pathname = root.pathname.slice(0, -"/batches".length);
  const batchPath = (id: string) => {
    const url = new URL(endpoint);
    url.pathname += `/${encodeURIComponent(id)}`;
    return url.toString();
  };
  const filePath = (id?: string) => {
    const url = new URL(root);
    url.pathname += `/files${id ? `/${encodeURIComponent(id)}/content` : ""}`;
    return url.toString();
  };
  const requestPath = "/v1/chat/completions";
  const jsonl = bodies.map((body, index) => JSON.stringify({ custom_id: `request-${index}`, method: "POST", url: requestPath, body })).join("\n") + "\n";
  const file = new File([jsonl], "shale-batch.jsonl", { type: "application/jsonl" });
  if (file.size > 200_000_000) throw new Error("Batch input exceeds the 200 MB limit");
  const hash = createHash("sha256").update(endpoint).update(resolveApiKey(options, role)).update(jsonl).digest("hex");
  const key = `model-batch:${role}:${hash}`;
  const signal = AbortSignal.any([AbortSignal.timeout(resolveBatchTimeout(options)), ...(options?.signal ? [options.signal] : [])]);
  const interval = resolveBatchPollInterval(options);
  const transportOptions = { ...options, endpoint };
  const client = createOpenAIClient(transportOptions, role);
  const request = { signal, timeout: resolveTimeout(transportOptions, role) };
  let saved = options?.batchStore?.get(key);
  let batchId = saved?.batchId;
  const report = batchProgress(role, bodies.length, batchId);
  let completed = 0;
  let failed = 0;
  try {
    if (!saved) {
      report("uploading");
      const uploaded = await client.files.create({ file, purpose: "batch" }, { ...request, path: filePath() });
      saved = { inputFileId: uploaded.id };
      options?.batchStore?.set(key, saved);
    }
    report(batchId ? "resuming" : "submitting");
    let batch = batchId
      ? await client.batches.retrieve(batchId, { ...request, path: batchPath(batchId) })
      : await client.batches.create({ input_file_id: saved.inputFileId, endpoint: requestPath, completion_window: "24h" },
        { ...request, path: endpoint, idempotencyKey: createHash("sha256").update(hash).update(saved.inputFileId).digest("hex") });
    batchId = batch.id;
    options?.batchStore?.set(key, { ...saved, batchId });
    const reportBatch = () => {
      completed = batch.request_counts?.completed ?? 0;
      failed = batch.request_counts?.failed ?? 0;
      report(`${batchId} ${batch.status}`, completed, failed);
    };
    reportBatch();
    while (!["completed", "failed", "expired", "cancelled"].includes(batch.status)) {
      await delay(interval, undefined, { signal });
      batch = await client.batches.retrieve(batchId, { ...request, path: batchPath(batchId) });
      reportBatch();
    }
    if (batch.status !== "completed" || !batch.output_file_id || batch.request_counts?.failed) {
      options?.batchStore?.delete(key);
      throw new Error(`Batch ${batchId} ${batch.status}: ${batch.errors?.data?.map(error => error.message).join("; ") || `${batch.request_counts?.failed ?? 0} requests failed`}`);
    }
    report(`${batchId} downloading`, completed, failed);
    const content = await client.files.content(batch.output_file_id, { ...request, path: filePath(batch.output_file_id) });
    const results = parseBatchOutput<T>(await content.text(), bodies.length);
    options?.batchStore?.delete(key);
    report(`${batchId} finished`, bodies.length, 0);
    return results;
  } catch (error) {
    report(`${batchId ? `${batchId} ` : ""}interrupted`, completed, failed);
    // Keep submitted IDs on transport failure or timeout so recovery can resume polling.
    throw new Error(`OpenAI ${role} batch${batchId ? ` ${batchId}` : ""} at ${endpoint}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
