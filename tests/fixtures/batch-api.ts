import type { FetchFn } from "../../lib/ai/types";

/** In-memory OpenAI Batch/Files server, including multipart uploads and unordered JSONL output. */
export function batchTransport() {
  const uploads: Array<{ url: string; lines: any[] }> = [];
  const submissions: Array<{ url: string; body: any; authorization: string | null }> = [];
  const retrievals: string[] = [];
  const files = new Map<string, any[]>();
  const batches = new Map<string, any>();
  const controls = { status: "completed", failed: 0, output: undefined as string | undefined };
  const fetchFn: FetchFn = async (url, init) => {
    const address = String(url);
    if (address === "data:,") return new Response("");
    init?.signal?.throwIfAborted();
    const path = new URL(address).pathname;
    if (path.endsWith("/files") && init?.method === "POST") {
      const form = init.body instanceof FormData ? init.body : await new Request(address, init).formData();
      const file = form.get("file") as File;
      const lines = (await file.text()).trim().split("\n").map(line => JSON.parse(line));
      const id = `file-${uploads.length}`;
      uploads.push({ url: address, lines });
      files.set(id, lines);
      return Response.json({ id });
    }
    if (path.endsWith("/batches") && init?.method === "POST") {
      const body = JSON.parse(init.body);
      const id = `batch-${submissions.length}`;
      submissions.push({ url: address, body, authorization: new Headers(init.headers).get("authorization") });
      const batch = { id, input_file_id: body.input_file_id, status: "in_progress", output_file_id: `output-${id}` };
      batches.set(id, batch);
      return Response.json(batch);
    }
    if (/\/batches\/batch-\d+$/.test(path)) {
      retrievals.push(address);
      const batch = batches.get(path.split("/").at(-1)!);
      return Response.json({ ...batch, status: controls.status, request_counts: { failed: controls.failed } });
    }
    if (/\/files\/output-batch-\d+\/content$/.test(path)) {
      const id = path.split("/").at(-2)!.replace("output-", "");
      const lines = files.get(batches.get(id).input_file_id)!;
      const output = lines.map(line => ({ custom_id: line.custom_id, error: null,
        response: { status_code: 200, body: line.body.input
          ? { data: line.body.input.map((text: string, index: number) => ({ index, embedding: [Number(text) || 1, 2] })) }
          : { model: line.body.model, choices: [{ message: { content: line.body.messages.at(-1).content }, finish_reason: "stop" }] } },
      })).reverse().map(line => JSON.stringify(line)).join("\n");
      return new Response(controls.output ?? output);
    }
    throw new Error(`Unexpected Batch API request: ${init?.method} ${address}`);
  };
  return { fetchFn, uploads, submissions, retrievals, controls };
}
