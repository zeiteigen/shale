import { getSDK, type ShaleSDK } from "@shale/sdk";
import { parseWebPage } from "./parser";
import type { WebPageParseRequest } from "./types";

export async function setup(sdkOverride?: ShaleSDK): Promise<void> {
  const sdk = sdkOverride ?? getSDK(import.meta.dir);
  sdk.messages.handle("web:parse", (request: WebPageParseRequest) => parseWebPage(sdk, request), {
    name: "web-page-parser", priority: 20,
    canHandle: (request) => Boolean(request?.url && /^https?:/i.test(request.url)),
  });
  sdk.logger.info("web-page-parser message handler registered.");
}
export default setup;
