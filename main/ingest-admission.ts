import type { IngestMaterial } from "../lib/ingest.types";
export interface IngestSubscriber {
  reciever_name: string;
  accept?: (item: IngestMaterial) => Promise<unknown> | unknown;
  inspect?: (req: Request) => Promise<Response> | Response;
  capabilities?: () => unknown;
}
export async function admitIngest(
  item: IngestMaterial,
  targets: Iterable<string | IngestSubscriber>,
  enqueue: (item: IngestMaterial) => void,
): Promise<Response> {
  const target = [...targets].find(
    (h) =>
      (typeof h === "string" ? h : h.reciever_name) === item.target_processor,
  );
  if (!target)
    return Response.json(
      { error: "Unknown ingest subscriber" },
      { status: 404 },
    );
  if (typeof target === "string" || !target.accept) {
    enqueue(item);
    return Response.json({ status: "queued", durable: false }, { status: 202 });
  }
  try {
    return Response.json(await target.accept(item), { status: 202 });
  } catch (error: any) {
    const status =
      Number.isInteger(error?.status) &&
      error.status >= 400 &&
      error.status <= 599
        ? error.status
        : 503;
    return Response.json(
      { error: status === 503 ? "Durable admission failed" : error.message },
      {
        status,
        headers:
          status === 429 || status === 503 ? { "Retry-After": "5" } : undefined,
      },
    );
  }
}
