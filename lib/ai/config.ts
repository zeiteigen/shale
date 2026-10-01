import type { AIClientOptions } from "./types";

export type ModelRole = "chat" | "embedding";

function endpointFor(role: ModelRole, options?: AIClientOptions): string {
  const suffix = role === "chat" ? "/chat/completions" : "/embeddings";
  const specificEndpoint =
    role === "chat"
      ? process.env.OPENAI_CHAT_ENDPOINT
      : process.env.EMBEDDING_ENDPOINT;
  const specificBase =
    role === "chat"
      ? process.env.OPENAI_CHAT_BASE_URL
      : process.env.EMBEDDING_BASE_URL;
  const explicit = options?.endpoint;
  const configuredBase = options?.baseUrl ?? options?.client?.baseURL;
  const base =
    configuredBase ??
    specificBase ??
    process.env.OPENAI_BASE_URL ??
    "https://api.openai.com/v1";
  const endpoint =
    explicit ??
    (configuredBase === undefined
      ? (specificEndpoint ?? process.env.OPENAI_ENDPOINT)
      : undefined);
  const result =
    endpoint ??
    (base.replace(/\/+$/, "").endsWith(suffix)
      ? base.replace(/\/+$/, "")
      : `${base.replace(/\/+$/, "")}${suffix}`);
  const url = new URL(result);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Model endpoints must use HTTP or HTTPS");
  }
  if (
    (role === "chat" && url.pathname.endsWith("/embeddings")) ||
    (role === "embedding" && url.pathname.endsWith("/chat/completions"))
  ) {
    throw new Error(
      `The ${role} profile points to an endpoint for the other model role`,
    );
  }
  return result;
}

export const resolveChatEndpoint = (options?: AIClientOptions): string =>
  endpointFor("chat", options);
export const resolveEmbeddingEndpoint = (options?: AIClientOptions): string =>
  endpointFor("embedding", options);

export function isLocalEndpoint(endpoint?: string): boolean {
  if (!endpoint) return false;
  try {
    const host = new URL(
      endpoint.includes("://") ? endpoint : `http://${endpoint}`,
    ).hostname;
    return (
      [
        "localhost",
        "127.0.0.1",
        "0.0.0.0",
        "[::1]",
        "host.docker.internal",
      ].includes(host) || host.endsWith(".local")
    );
  } catch {
    return false;
  }
}

function numericSetting(
  value: string | number | undefined,
  name: string,
  minimum: number,
): number | undefined {
  if (value === undefined || value === "") return undefined;
  const number = Number(value);
  if (
    !Number.isFinite(number) ||
    !Number.isInteger(number) ||
    number < minimum
  ) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return number;
}

export function resolveTimeout(
  options?: AIClientOptions,
  role: ModelRole = "chat",
): number {
  const specific =
    role === "chat"
      ? (process.env.CHAT_TIMEOUT_MS ?? process.env.OPENAI_CHAT_TIMEOUT_MS)
      : (process.env.EMBEDDING_TIMEOUT_MS ??
        process.env.OPENAI_EMBEDDING_TIMEOUT_MS);
  return (
    numericSetting(
      options?.timeoutMs ??
        options?.client?.timeout ??
        specific ??
        process.env.MODEL_TIMEOUT_MS ??
        process.env.OPENAI_TIMEOUT_MS,
      "Model timeout",
      1,
    ) ?? (isLocalEndpoint(endpointFor(role, options)) ? 300_000 : 60_000)
  );
}

export function resolveModelResource(
  endpoint: string,
  resource?: string | null,
): string | null {
  const resolved =
    resource !== undefined
      ? resource
      : isLocalEndpoint(endpoint)
        ? (process.env.MODEL_GPU_RESOURCE ?? "local-gpu")
        : null;
  if (resolved !== null && !resolved.trim())
    throw new Error("Model GPU resource must be a nonempty name or null");
  return resolved;
}

export function resolveRetries(
  options?: AIClientOptions,
  role: ModelRole = "chat",
): number {
  return (
    numericSetting(
      options?.maxRetries ??
        options?.client?.maxRetries ??
        process.env.OPENAI_MAX_RETRIES,
      "Model retries",
      0,
    ) ?? (isLocalEndpoint(endpointFor(role, options)) ? 2 : 0)
  );
}

export function resolveApiKey(
  options?: AIClientOptions,
  role: ModelRole = "chat",
): string {
  return [
    options?.apiKey,
    options?.client?.apiKey,
    (role === "embedding"
      ? process.env.EMBEDDING_API_KEY
      : process.env.OPENAI_CHAT_API_KEY),
    process.env.OPENAI_API_KEY,
  ].find((key) => key?.trim()) ?? "dummy";
}
