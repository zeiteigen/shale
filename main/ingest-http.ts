import { isIngestMaterial, type IngestMaterial } from "../lib/ingest.types";
import { admitIngest, type IngestSubscriber } from "./ingest-admission";
const MAX_HTTP_BYTES = 4_000_000;
export async function handleIngestRequest(
  req: Request,
  targets: Iterable<string | IngestSubscriber>,
  enqueue: (item: IngestMaterial) => void,
): Promise<Response> {
  if (req.method !== "POST")
    return Response.json(
      { error: "POST required" },
      { status: 405, headers: { Allow: "POST" } },
    );
  if (Number(req.headers.get("content-length")) > MAX_HTTP_BYTES)
    return Response.json({ error: "Payload too large" }, { status: 413 });
  const reader = req.body?.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  if (reader) {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.length;
        if (bytes > MAX_HTTP_BYTES) {
          await reader.cancel();
          return Response.json({ error: "Payload too large" }, { status: 413 });
        }
        chunks.push(next.value);
      }
    } catch {
      return Response.json(
        { error: "Could not read payload" },
        { status: 400 },
      );
    }
  }
  let body: unknown;
  try {
    const data = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
    body = JSON.parse(new TextDecoder().decode(data));
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!isIngestMaterial(body))
    return Response.json({ error: "Invalid ingest payload" }, { status: 400 });
  return admitIngest(body, targets, enqueue);
}
