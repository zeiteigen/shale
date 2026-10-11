import type { ShaleSDK } from "@shale/sdk";
import type { DirectorySettings } from "./settings.types";
import type { DirectoryInfo, DirectoryResult, PendingDirectoryFile, PreparedDirectoryFile } from "./types";
import { fileVersion } from "./scan";
import { checkpointId, fileStateKey } from "./file-state";
import { fingerprintFile } from "../../lib/memory/fingerprint";
import { memoryChunks, prepareSourceMemory } from "../../lib/memory/prepare";

function compactKnowledgeValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return value.length <= 1000 ? value : `${value.slice(0, 1000)}…`;
  if (Array.isArray(value)) return value.slice(0, 64).map(item => compactKnowledgeValue(item, depth + 1));
  if (value && typeof value === "object" && depth < 6) return Object.fromEntries(
    Object.entries(value).slice(0, 64).map(([key, item]) => [key, compactKnowledgeValue(item, depth + 1)]));
  return value;
}

/** Prepare and checkpoint one file before its transactional commit. */
export async function prepareDirectoryFile(
  sdk: ShaleSDK, settings: DirectorySettings, force: boolean, namespace: string,
  directory: DirectoryInfo, result: DirectoryResult, filePath: string,
): Promise<PendingDirectoryFile | null> {
  try {
    const version = await fileVersion(filePath);
    if (!force && sdk.state.getWatermark(fileStateKey(namespace, filePath)) === version.fingerprint) {
      result.filesSkipped++;
      return null;
    }
    if (version.size > (settings.maxFileSizeMB ?? 50) * 1024 * 1024) {
      throw new Error("File exceeds maxFileSizeMB");
    }
    const id = checkpointId(sdk, namespace, filePath);
    const cached = sdk.checkpoint.get<PreparedDirectoryFile>(id);
    if (!force && cached?.data.type === "directory_file" && cached.data.fingerprint === version.fingerprint) {
      return { id, data: cached.data, result };
    }
    const capability = await sdk.messages.request("file:can-process", { filePath });
    if (!capability.canProcess) {
      result.filesSkipped++;
      return null;
    }
    const parsed = await sdk.messages.request("file:process", {
      filePath,
      options: { namespace, timeoutMs: settings.processingTimeoutMs ?? 120000 },
    }, { target: capability.supportedBy, timeoutMs: settings.processingTimeoutMs ?? 120000 });
    if (!parsed.success || !parsed.chunks.length) throw new Error(parsed.error ?? "Processor returned no chunks");
    if ((await fileVersion(filePath)).fingerprint !== version.fingerprint) {
      throw new Error("File changed while processing; it will be retried on the next scan");
    }
    // Keep canonical local identity regardless of processor URI formatting.
    const memory = prepareSourceMemory(parsed.chunks, { title: parsed.title, summary: parsed.description });
    const knowledge = (parsed.knowledge ?? []).flatMap(claim => {
      if (claim.chunkIndex === undefined) return [{ ...claim, value: claim.predicate === "DOCUMENT_SUMMARY" ? memory.summary : compactKnowledgeValue(claim.value) as typeof claim.value }];
      const snippet = memory.snippets.find(item => item.locator.originalChunkIndex === claim.chunkIndex);
      if (!snippet) return [];
      const value = claim.value && typeof claim.value === "object" && !Array.isArray(claim.value) && "text" in claim.value
        ? { ...claim.value, text: snippet.text } : snippet.text;
      return [{ ...claim, value: compactKnowledgeValue(value) as typeof claim.value }];
    });
    const data: PreparedDirectoryFile = { type: "directory_file", directory, filePath, namespace,
      fingerprint: version.fingerprint, updatedAt: version.updatedAt,
      sourceFingerprint: typeof parsed.metadata?.assetHash === "string" ? parsed.metadata.assetHash : await fingerprintFile(filePath),
      memory, parsed: { ...parsed, description: memory.summary, knowledge,
        chunks: memoryChunks(memory).map((chunk, chunk_index) => ({ ...chunk, chunk_index })) } };
    sdk.saveCheckpoint(data, { id, key: id });
    return { id, data, result };
  } catch (error) {
    result.errors.push({ filePath, error: error instanceof Error ? error.message : String(error) });
    sdk.logger.error(`Failed to prepare ${filePath}:`, error);
  }
  return null;
}
