import { discoverSettingsTargets, loadSettings, loadSettingsHelp, setSettingValue, resetSettingValue } from "../lib/settings-editor";

export async function settingsApi(req: Request, url: URL, rootDir: string): Promise<Response | undefined> {
  if (!url.pathname.startsWith("/api/settings")) return;
  const targets = discoverSettingsTargets(rootDir);
  if (url.pathname === "/api/settings" && req.method === "GET") {
    return Response.json({ targets: targets.map(({ name, hasSettings, hasHelp, manifest }) => ({
      name, hasSettings, hasHelp, title: manifest?.name ?? name, description: manifest?.description ?? "",
    })) });
  }
  const match = url.pathname.match(/^\/api\/settings\/([^/]+)(\/reset)?$/);
  if (!match) return Response.json({ error: "Unknown settings endpoint." }, { status: 404 });
  try {
    const name = decodeURIComponent(match[1]);
    if (!targets.some(target => target.name === name)) return Response.json({ error: "Unknown settings target." }, { status: 404 });
    if (req.method === "GET" && !match[2]) {
      return Response.json({ name, values: loadSettings(name, rootDir), schema: loadSettingsHelp(name, rootDir)?.settings ?? {} });
    }
    if (req.method !== "POST") return Response.json({ error: "Method not allowed." }, { status: 405 });
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected a JSON object.");
    const { key } = body;
    if (key !== undefined && (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key))) throw new Error("Invalid setting key.");
    if (match[2]) {
      if (key !== undefined && !key) throw new Error("Invalid setting key.");
      return Response.json(resetSettingValue(name, key, rootDir));
    }
    if (!key || typeof body.value !== "string") throw new Error("Provide a setting key and its value as text.");
    const schema = loadSettingsHelp(name, rootDir)?.settings ?? {};
    const current = loadSettings(name, rootDir);
    if (!Object.hasOwn(schema, key) && !Object.hasOwn(current, key)) throw new Error("Unknown setting key.");
    return Response.json(setSettingValue(name, key, body.value, rootDir));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Invalid settings request." }, { status: 400 });
  }
}
