import { statSync } from "node:fs";
import type { ShaleSDK } from "@shale/sdk";
import { parseDocumentFile, type ParsedDocument } from "./parse-document";
import { commitDocument } from "./commit-document";
import type { VaultContext } from "./graph";

export const documentCheckpointId = (filePath: string) => `document_analysis:${filePath}`;
export const documentWatermarkKey = (vaultPath: string) => `vault:${vaultPath}:documents:mtime`;

/** Save each prepared attachment immediately, before moving to the next file. */
export async function prepareVaultDocuments(
  filePaths: string[], vault: VaultContext, sdk: ShaleSDK, namespace: string,
): Promise<{ documents: ParsedDocument[]; failed: boolean }> {
  const documents: ParsedDocument[] = [];
  let failed = false;
  await sdk.models.mapChat(filePaths, async (filePath) => {
    try {
      const mtime = statSync(filePath).mtimeMs;
      const checkpointId = documentCheckpointId(filePath);
      const cached = sdk.checkpoint.get(checkpointId)?.data;
      const parsedDocument: ParsedDocument = cached?.type === "document_analysis"
        && cached.parsedDocument && cached.mtime === mtime && cached.namespace === namespace && cached.vault?.path === vault.path
        ? cached.parsedDocument : await parseDocumentFile(filePath, sdk, namespace);
      sdk.saveCheckpoint({ type: "document_analysis", namespace, vault, filePath, mtime, parsedDocument },
        { id: checkpointId, key: checkpointId });
      documents.push(parsedDocument);
    } catch (error) {
      failed = true;
      sdk.logger.error(`Failed to prepare document at ${filePath}:`, error);
    }
  });
  return { documents, failed };
}

/** Only embeddings and transactional writes run here, including during recovery. */
export async function finalizeDocument(
  document: ParsedDocument, vault: VaultContext, sdk: ShaleSDK, namespace: string,
  checkpointId = documentCheckpointId(document.filePath),
) {
  const texts = document.contextualChunks.map(chunk => chunk.text_content);
  const embeddings: number[][] = [];
  // Keep document-sized workloads bounded without issuing chat calls in Phase 2.
  for (let start = 0; start < texts.length; start += 64) {
    embeddings.push(...await sdk.embed(texts.slice(start, start + 64)));
  }
  return commitDocument(sdk, document, embeddings, vault, namespace, checkpointId);
}
