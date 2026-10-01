import { isIngestMaterial, type IngestMaterial } from "../lib/ingest.types";

/** Accept only requests that can be delivered to a registered ingest subscriber. */
export async function handleIngestRequest(
  req: Request,
  targets: Iterable<string>,
  enqueue: (item: IngestMaterial) => void,
): Promise<Response> {
  if (req.method !== "POST")
    return new Response("POST required", { status: 405, headers: { Allow: "POST" } });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  if (!isIngestMaterial(body))
    return new Response("Invalid ingest payload", { status: 400 });
  if (!new Set(targets).has(body.target_processor))
    return new Response("Unknown ingest subscriber", { status: 404 });
  enqueue(body);
  return new Response("OK", { status: 202 });
}
