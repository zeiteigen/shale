/** Append the chat completion path to a base URL, or validate a full request URL. */
export function modelEndpointUrl(base: string, endpoint?: string): string {
  const suffix = "/chat/completions";
  const url = new URL(endpoint ?? base);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Model endpoints must use HTTP or HTTPS");
  const path = url.pathname.replace(/\/+$/, "");
  if (endpoint !== undefined && (!path || /\/v\d+$/i.test(path))) {
    const setting = "OPENAI_CHAT_ENDPOINT";
    throw new Error(`${setting} must be a full request URL, such as ${url.origin}${path}${suffix}. Put the API base URL in OPENAI_BASE_URL instead.`);
  }
  if (endpoint === undefined) url.pathname = path.endsWith(suffix) ? path : `${path}${suffix}`;
  return url.toString();
}
