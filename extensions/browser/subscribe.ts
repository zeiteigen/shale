import { getSDK, type ShaleSDK } from "@shale/sdk";
import type { IngestMaterial } from "../../lib/ingest.types";
import type { BrowserIngestPayload } from "./types";
import { enqueueBrowserPayload } from "./ingest-queue";

let cachedSdk: ShaleSDK | null = null;

function resolveSDK(): ShaleSDK {
  if (!cachedSdk) {
    cachedSdk = getSDK(import.meta.dir);
  }
  return cachedSdk;
}

/**
 * Optional initialization hook called when the extension is registered.
 */
export async function init(): Promise<void> {
  const sdk = resolveSDK();
  sdk.logger.info("Browser ingestion subscription hook initialized.");
}

/**
 * Push ingestion entrypoint invoked by the Shale ingest router.
 *
 * @param item Inbound HTTP payload matching IngestMaterial
 * @param sdkOverride Optional scoped SDK instance
 */
export async function subscribe(
  item: IngestMaterial,
  sdkOverride?: ShaleSDK,
): Promise<void> {
  const sdk = sdkOverride ?? resolveSDK();

  try {
    let payload: BrowserIngestPayload;
    if (typeof item.content === "string") {
      payload = JSON.parse(item.content);
    } else if (typeof item.content === "object" && item.content !== null) {
      payload = item.content as any;
    } else {
      sdk.logger.warn("Received empty or malformed browser ingest payload.");
      return;
    }

    const queueLength = enqueueBrowserPayload(sdk, payload);
    sdk.logger.info(
      `Queued browser payload: type="${payload.type}" (origin: ${item.metadata.data_origin}, pending: ${queueLength}).`,
    );
  } catch (err: any) {
    sdk.logger.error(
      `Error processing browser ingestion payload: ${err?.message || err}`,
    );
  }
}

export default subscribe;
