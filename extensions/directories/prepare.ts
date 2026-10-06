import type { ShaleSDK } from "@shale/sdk";
import type { DirectorySettings } from "./settings.types";
import type { DirectoryResult, PendingDirectoryFile } from "./types";
import { resolveDirectory, scanFiles } from "./scan";
import { prepareDirectoryFile } from "./prepare-file";
import { resolveChatBatchWidth } from "../../lib/ai/batch-config";

export async function prepareDirectories(sdk: ShaleSDK, settings: DirectorySettings, force: boolean) {
  const results: DirectoryResult[] = [];
  const pending: PendingDirectoryFile[] = [];
  const seenFiles = new Set<string>();
  const seenDirectories = new Set<string>();
  const namespace = settings.namespace ?? sdk.namespace;
  for (const selectedPath of settings.directories ?? []) {
    const result: DirectoryResult = { directory: selectedPath, filesProcessed: 0, filesSkipped: 0, chunksCreated: 0, errors: [] };
    try {
      const directory = await resolveDirectory(selectedPath);
      if (seenDirectories.has(directory.path)) continue;
      seenDirectories.add(directory.path);
      result.directory = directory.path;
      results.push(result);
      const window: string[] = [];
      const width = resolveChatBatchWidth(sdk.llm.options());
      const flush = async () => {
        const prepared = await sdk.models.mapChat(window.splice(0), filePath =>
          prepareDirectoryFile(sdk, settings, force, namespace, directory, result, filePath));
        pending.push(...prepared.filter((file): file is PendingDirectoryFile => file !== null));
      };
      for await (const filePath of scanFiles(directory.path, settings, (path, error) => {
        result.errors.push({ filePath: path, error: error instanceof Error ? error.message : String(error) });
        sdk.logger.error(`Failed to scan ${path}:`, error);
      })) {
        if (seenFiles.has(filePath)) continue;
        seenFiles.add(filePath);
        window.push(filePath);
        if (window.length >= width) await flush();
      }
      await flush();
    } catch (error) {
      if (!results.includes(result)) results.push(result);
      result.errors.push({ filePath: selectedPath, error: error instanceof Error ? error.message : String(error) });
      sdk.logger.error(`Failed to scan ${selectedPath}:`, error);
    }
  }
  return { results, pending };
}
