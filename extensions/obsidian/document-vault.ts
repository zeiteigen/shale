import { statSync } from "node:fs";
import type { ShaleSDK } from "@shale/sdk";
import { parseDocumentFile, type ParsedDocument } from "./parse-document";
import { commitDocument } from "./commit-document";
import type { VaultContext } from "./graph";
import { compactParsedDocument } from "./memory";

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
      sdk.saveCheckpoint({ type: "document_analysis", namespace, vault, filePath, mtime, parsedDocument: compactParsedDocument(parsedDocument) },
        { id: checkpointId, key: checkpointId });
      documents.push(parsedDocument);
    } catch (error) {
      failed = true;
      sdk.logger.error(`Failed to prepare document at ${filePath}:`, error);
    }
  });
  return { documents, failed };
}

/** Commit a prepared document and its graph evidence. */
export async function finalizeDocument(
  document: ParsedDocument, vault: VaultContext, sdk: ShaleSDK, namespace: string,
  checkpointId = documentCheckpointId(document.filePath),
) {
  return commitDocument(sdk, document, vault, namespace, checkpointId);
}
