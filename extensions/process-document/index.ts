import { getSDK, type ShaleSDK } from "@shale/sdk";
import { setup } from "./setup";

export { setup };
export { canProcessDocument, DEFAULT_DOCUMENT_EXTENSIONS, type DocumentFormat } from "./document-format";
export { parseDocumentFile } from "./parse-document";
export { processDocumentFile, processDocumentFilesBatch } from "./process-document";
export type { ProcessDocumentSettings } from "./settings.types";

export async function run(sdkOverride?: ShaleSDK): Promise<void> {
  await setup(sdkOverride ?? getSDK(import.meta.dir));
}

export default run;
