import { getSDK, type ShaleSDK } from "@shale/sdk";
import {
  canProcessImage,
  processImageFile,
  processImageFilesBatch,
} from "./process-image";
import type {
  ProcessFileRequest,
  ProcessFilesBatchRequest,
  CanProcessFileRequest,
  CanProcessFilesRequest,
} from "../../lib/messages.types";

/**
 * Setup hook called by Shale host when the extension is initialized.
 * Registers cross-extension message handlers on the SDK message bus.
 */
export async function setup(sdkOverride?: ShaleSDK): Promise<void> {
  const sdk = sdkOverride ?? getSDK(import.meta.dir);

  sdk.logger.info("Initializing process-image extension message handlers...");

  // 1. Register "file:process" channel handler for single or bulk image files
  sdk.messages.handle(
    "file:process",
    async (req: ProcessFileRequest) => {
      return processImageFile(req, sdk);
    },
    {
      name: "process-image",
      priority: 10,
      canHandle: (req: ProcessFileRequest) => {
        if (req.fileType === "image") return true;
        if (req.filePath) return canProcessImage(req.filePath);
        if (Array.isArray(req.filePaths) && req.filePaths.length > 0) {
          return req.filePaths.some((p) => canProcessImage(p));
        }
        if (Array.isArray(req.files) && req.files.length > 0) {
          return req.files.some((f) =>
            typeof f === "string"
              ? canProcessImage(f)
              : f.fileType === "image" || canProcessImage(f.filePath),
          );
        }
        return false;
      },
    },
  );

  // 2. Register "files:process" and "file:process-batch" bulk channel handlers
  const batchHandler = async (req: ProcessFilesBatchRequest) => {
    return processImageFilesBatch(req, sdk);
  };
  const batchCanHandle = (req: ProcessFilesBatchRequest) => {
    if (req.fileType === "image") return true;
    if (Array.isArray(req.filePaths) && req.filePaths.length > 0) {
      return req.filePaths.some((p) => canProcessImage(p));
    }
    if (Array.isArray(req.files) && req.files.length > 0) {
      return req.files.some((f) =>
        typeof f === "string"
          ? canProcessImage(f)
          : f.fileType === "image" || canProcessImage(f.filePath),
      );
    }
    return false;
  };

  sdk.messages.handle("files:process", batchHandler, {
    name: "process-image",
    priority: 10,
    canHandle: batchCanHandle,
  });

  sdk.messages.handle("file:process-batch", batchHandler, {
    name: "process-image",
    priority: 10,
    canHandle: batchCanHandle,
  });

  // 3. Register "file:can-process" channel handler
  sdk.messages.handle(
    "file:can-process",
    async (req: CanProcessFileRequest) => {
      const can =
        req.fileType === "image" ||
        (req.filePath ? canProcessImage(req.filePath) : false);
      return {
        canProcess: can,
        supportedBy: "process-image",
        priority: 10,
      };
    },
    {
      name: "process-image",
    },
  );

  // 4. Register "files:can-process" bulk capability channel handler
  sdk.messages.handle(
    "files:can-process",
    async (req: CanProcessFilesRequest) => {
      const results: Record<string, any> = {};
      let all = true;
      const filePaths = req.filePaths || [];
      for (const fp of filePaths) {
        const can = req.fileType === "image" || canProcessImage(fp);
        results[fp] = {
          canProcess: can,
          supportedBy: can ? "process-image" : undefined,
          priority: 10,
        };
        if (!can) all = false;
      }
      return {
        canProcessAll: all && filePaths.length > 0,
        results,
      };
    },
    {
      name: "process-image",
    },
  );

  sdk.logger.info(
    "process-image extension message handlers registered successfully.",
  );
}

export default setup;
