import type { IngestSubscriber } from "./ingest-admission";
export function connectorCapabilities(targets: Iterable<IngestSubscriber>) {
  return {
    service: "shale",
    processors: [...targets].map((h) => ({
      name: h.reciever_name,
      durable: !!h.accept,
      ...((h.capabilities?.() as object) ?? {}),
    })),
  };
}
export function handleConnectorRequest(
  req: Request,
  targets: Iterable<IngestSubscriber>,
): Response | Promise<Response> {
  const parts = new URL(req.url).pathname.split("/");
  const target = [...targets].find((h) => h.reciever_name === parts[2]);
  return (
    target?.inspect?.(req) ??
    Response.json({ error: "Unknown connector endpoint" }, { status: 404 })
  );
}
