import type { AuthProvider, AuthStatus, ShaleSDK } from "../sdk";

export type AuthRegistry = Map<string, { provider: AuthProvider; sdk: ShaleSDK }>;

const MAX_VALUE = 8192;

function values(body: unknown): Record<string, string> {
  const raw = (body as { values?: unknown })?.values;
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected values as an object of strings.");
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Invalid field name.");
    if (typeof value !== "string" || value.length > MAX_VALUE) throw new Error(`Field ${key} must be text up to ${MAX_VALUE} characters.`);
    result[key] = value;
  }
  return result;
}

async function safeStatus(provider: AuthProvider, sdk: ShaleSDK): Promise<AuthStatus> {
  try { return await provider.status(sdk); }
  catch (error) { return { connected: false, error: error instanceof Error ? error.message : String(error) }; }
}

/** Connect, verify, and disconnect extension accounts from the local web interface. Secrets are write-only. */
export async function authApi(req: Request, url: URL, registry: AuthRegistry): Promise<Response | undefined> {
  if (!url.pathname.startsWith("/api/auth")) return;
  if (url.pathname === "/api/auth" && req.method === "GET") {
    const accounts = await Promise.all([...registry].map(async ([extension, { provider, sdk }]) => ({
      extension, title: provider.title, description: provider.description, warning: provider.warning,
      methods: provider.methods, canVerify: typeof provider.verify === "function", status: await safeStatus(provider, sdk),
    })));
    return Response.json({ accounts });
  }
  const match = url.pathname.match(/^\/api\/auth\/([^/]+)\/(connect|submit|verify|disconnect)$/);
  if (!match) return Response.json({ error: "Unknown auth endpoint." }, { status: 404 });
  if (req.method !== "POST") return Response.json({ error: "Method not allowed." }, { status: 405 });
  const entry = registry.get(decodeURIComponent(match[1]!));
  if (!entry) return Response.json({ error: "Unknown extension." }, { status: 404 });
  const { provider, sdk } = entry;
  try {
    const body = await req.json().catch(() => { throw new Error("Expected a JSON body."); });
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected a JSON object.");
    switch (match[2]) {
      case "connect": {
        const method = provider.methods.find(item => item.id === body.method);
        if (!method) throw new Error("Unknown sign-in method.");
        const input = values(body);
        const missing = method.fields.filter(field => field.required && !input[field.key]?.trim());
        if (missing.length) throw new Error(`Missing ${missing.map(field => field.label).join(", ")}.`);
        return Response.json({ status: await provider.connect(sdk, method.id, input) });
      }
      case "submit":
        if (!provider.submit) throw new Error("This account has no pending sign-in step.");
        return Response.json({ status: await provider.submit(sdk, values(body)) });
      case "verify":
        if (!provider.verify) throw new Error("This account cannot be verified.");
        return Response.json({ status: await provider.verify(sdk) });
      default:
        if (body.confirm !== true) throw new Error("Confirm disconnecting first.");
        await provider.disconnect(sdk);
        return Response.json({ status: await safeStatus(provider, sdk) });
    }
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Auth request failed." }, { status: 400 });
  }
}
