import { getSDK, type ShaleSDK } from "@shale/sdk";
import type { IngestMaterial } from "../../lib/ingest.types";
import {
  BROWSER_PROTOCOL_VERSION,
  MAX_BROWSER_BYTES,
  MAX_BROWSER_RECORDS,
} from "../../lib/browser-contract";
import { BrowserProtocolError } from "../../lib/browser-validation";
import { admitBrowserPayload } from "./admission";
import { migrateLegacyInbox } from "./inbox-store";
import { wakeBrowserWorker } from "./worker-scheduler";
import { browserStatus, retryBrowserJobs } from "./status";
import { queryBrowser, correctContext } from "./retrieval";
import type { BrowserExtensionSettings } from "./settings.types";
import { refreshBrowserSource } from './refresh';
let cachedSdk: ShaleSDK | null = null;
const resolveSDK = () => (cachedSdk ??= getSDK(import.meta.dir));
export function capturePolicy(sdk: ShaleSDK) {
  const settings = sdk.settings.getAll<BrowserExtensionSettings>();
  return {
    protocolVersion: 1 as const,
    excludeDomains: settings.excludeDomains ?? [],
    excludePatterns: settings.excludePatterns ?? [],
    excludePrivateBrowsing: settings.excludePrivateBrowsing !== false,
    sessionInactivityMinutes: settings.sessionInactivityMinutes ?? 30,
  };
}
export async function init(): Promise<void> {
  const sdk = resolveSDK();
  migrateLegacyInbox(sdk);
  sdk.messages.handle('source:refresh',request=>refreshBrowserSource(sdk,request));
  sdk.messages.handle("browser:query", (filter) => queryBrowser(sdk, filter), {
    name: "browser",
  });
  sdk.messages.handle("browser:policy", () => capturePolicy(sdk), {
    name: "browser",
  });
  wakeBrowserWorker(sdk);
}
export async function accept(item: IngestMaterial, sdkOverride?: ShaleSDK) {
  const sdk = sdkOverride ?? resolveSDK();
  let payload: unknown;
  try {
    payload = JSON.parse(item.content);
  } catch {
    throw new BrowserProtocolError("Invalid browser JSON");
  }
  const receipt = admitBrowserPayload(sdk, payload);
  if (!sdkOverride) wakeBrowserWorker(sdk);
  return receipt;
}
export async function subscribe(
  item: IngestMaterial,
  sdkOverride?: ShaleSDK,
): Promise<void> {
  await accept(item, sdkOverride);
}
export function capabilities() {
  return {
    protocolVersions: [BROWSER_PROTOCOL_VERSION],
    maxBytes: MAX_BROWSER_BYTES,
    maxRecords: MAX_BROWSER_RECORDS,
  };
}
export async function inspect(
  req: Request,
  sdkOverride?: ShaleSDK,
): Promise<Response> {
  const sdk = sdkOverride ?? resolveSDK();
  const url = new URL(req.url),
    endpoint = url.pathname.split("/").at(-1);
  try {
    if (req.method === "GET") {
      if (endpoint === "policy") return Response.json(capturePolicy(sdk));
      if (endpoint === "status") {
        const ids = url.searchParams.get("ids")?.split(",").filter(Boolean);
        if (ids && (ids.length > 100 || ids.some((id) => id.length > 200)))
          throw new Error("Invalid receipt IDs");
        return Response.json(browserStatus(sdk, ids));
      }
      if (endpoint === "library")
        return Response.json(
          queryBrowser(sdk, {
            query: url.searchParams.get("query") ?? undefined,
            collectorId: url.searchParams.get("collectorId") ?? undefined,
            sessionId: url.searchParams.get("sessionId") ?? undefined,
            threadId: url.searchParams.get("threadId") ?? undefined,
            goal: url.searchParams.get("goal") ?? undefined,
            topic: url.searchParams.get("topic") ?? undefined,
            domain: url.searchParams.get("domain") ?? undefined,
            quality: (url.searchParams.get("quality") ?? undefined) as any,
            from: url.searchParams.has("from")
              ? Number(url.searchParams.get("from"))
              : undefined,
            to: url.searchParams.has("to")
              ? Number(url.searchParams.get("to"))
              : undefined,
            limit: url.searchParams.has("limit")
              ? Number(url.searchParams.get("limit"))
              : undefined,
          }),
        );
    }
    if (req.method === "POST" && ["retry", "context"].includes(endpoint!)) {
      const body = await req.text();
      if (new TextEncoder().encode(body).length > 32000)
        throw new Error("Command too large");
      const input = JSON.parse(body);
      if (endpoint === "retry") {
        if (
          !Array.isArray(input.ids) ||
          input.ids.length > 100 ||
          input.ids.some(
            (id: unknown) => typeof id !== "string" || id.length > 200,
          )
        )
          throw new Error("Invalid retry IDs");
        retryBrowserJobs(sdk, input.ids);
        if (!sdkOverride) wakeBrowserWorker(sdk);
        return Response.json({ success: true });
      }
      const result = correctContext(sdk, input);
      if (!sdkOverride) wakeBrowserWorker(sdk);
      return Response.json(result);
    }
    return Response.json(
      { error: "Unknown browser endpoint or method" },
      { status: 404 },
    );
  } catch (error: any) {
    return Response.json({ error: error.message }, { status: 400 });
  }
}
export default subscribe;
