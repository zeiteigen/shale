/** Keep privileged local controls inaccessible to other sites and DNS rebinding. */
export function rejectNonLocalRequest(req: Request): Response | undefined {
  const url = new URL(req.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    return Response.json({ error: "Only local hosts are allowed." }, { status: 403 });
  }
  const origin = req.headers.get("Origin");
  if ((origin && origin !== url.origin) || req.headers.get("Sec-Fetch-Site") === "cross-site") {
    return Response.json({ error: "Cross-origin requests are not allowed." }, { status: 403 });
  }
}
