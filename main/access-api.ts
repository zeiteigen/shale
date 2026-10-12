import { createExtensionSDK, type ShaleSDK } from "../sdk";
import { createScopedSDK } from "../sdk/access";
import { LIVE_SOURCE_CONTENT_HASH_SQL } from "../lib/access/source-hash";
import { readAccessPolicy, TIERS, writeAccessPolicy } from "../lib/access/policy";
import { clearLabel, listLabels, setLabel, type LabelKind } from "../lib/access/schema";
import { createToken, listTokens, revokeToken } from "../lib/access/tokens";
import { recordTier } from "../lib/access/visibility";

const KINDS = new Set<LabelKind>(["source", "entity", "claim"]);

let shared: ShaleSDK | undefined;
function graphSdk() {
  return shared ??= createExtensionSDK("access", { namespace: "knowledge" });
}

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

async function body(req: Request): Promise<Record<string, unknown>> {
  const value = await req.json().catch(() => { throw new Error("Expected a JSON body."); });
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object.");
  return value;
}

function record(input: { kind?: unknown; id?: unknown }) {
  if (typeof input.kind !== "string" || !KINDS.has(input.kind as LabelKind)) throw new Error("kind must be source, entity, or claim.");
  if ((typeof input.id !== "string" && typeof input.id !== "number") || String(input.id).length > 1000) throw new Error("Provide a record id.");
  return { kind: input.kind as LabelKind, id: String(input.id) };
}

/** What each profile can see, per origin; the check for "what does the cloud agent see?". */
function preview(sdk: ShaleSDK) {
  const policy = readAccessPolicy();
  const profiles: Record<string, unknown> = {};
  for (const name of Object.keys(policy.profiles)) {
    try {
      const access = createScopedSDK(name, sdk);
      access.refresh();
      const db = access.read.database;
      const count = (sql: string) => db.query<{ n: number }, []>(sql).get()!.n;
      profiles[name] = {
        unrestricted: access.profile.unrestricted,
        sources: count("SELECT count(*) AS n FROM sources"),
        entities: count("SELECT count(*) AS n FROM entities"),
        claims: count("SELECT count(*) AS n FROM graph_claims"),
        origins: db.query<{ origin: string; n: number }, []>("SELECT origin,count(*) AS n FROM sources GROUP BY origin ORDER BY n DESC").all(),
      };
    } catch (error) {
      profiles[name] = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  return profiles;
}

function classification(sdk: ShaleSDK) {
  const db = sdk.database;
  const row = (sql: string) => db.query<{ n: number }, []>(sql).get()!.n;
  return {
    sources: row("SELECT count(*) AS n FROM sources"),
    heuristic: row(`SELECT count(*) AS n FROM sources s JOIN graph_access_labels l ON l.kind='source' AND l.record_id=s.id
      AND l.origin='heuristic' AND l.content_hash=${LIVE_SOURCE_CONTENT_HASH_SQL}`),
    llm: row(`SELECT count(*) AS n FROM sources s JOIN graph_access_labels l ON l.kind='source' AND l.record_id=s.id
      AND l.origin='llm' AND l.content_hash=${LIVE_SOURCE_CONTENT_HASH_SQL}`),
    manual: row("SELECT count(*) AS n FROM graph_access_labels WHERE origin='manual'"),
    tiers: db.query<{ origin: string; tier: number; n: number }, []>(`SELECT l.origin,l.tier,count(*) AS n FROM graph_access_labels l
      WHERE l.kind='source' GROUP BY l.origin,l.tier`).all(),
  };
}

/** Access profiles, tokens, and sensitivity labels for the local web interface. */
export async function accessApi(req: Request, url: URL, sdk = graphSdk()): Promise<Response | undefined> {
  if (!url.pathname.startsWith("/api/access")) return;
  try {
    if (url.pathname === "/api/access") {
      if (req.method === "GET") {
        const origins = sdk.database.query<{ origin: string; n: number }, []>(
          "SELECT origin,count(*) AS n FROM sources GROUP BY origin ORDER BY n DESC").all();
        return json({ tiers: TIERS, policy: readAccessPolicy(), tokens: listTokens(), origins, classification: classification(sdk) });
      }
      if (req.method === "PUT") return json({ policy: writeAccessPolicy((await body(req)).policy) });
      return json({ error: "Method not allowed." }, 405);
    }
    if (url.pathname === "/api/access/preview" && req.method === "GET") return json({ profiles: preview(sdk) });
    if (url.pathname === "/api/access/tokens" && req.method === "POST") {
      const input = await body(req);
      if (typeof input.profile !== "string") throw new Error("Choose a profile.");
      return json({ token: createToken(input.profile, typeof input.label === "string" ? input.label : "") }, 201);
    }
    const token = url.pathname.match(/^\/api\/access\/tokens\/([A-Za-z0-9]+)$/);
    if (token && req.method === "DELETE") {
      if (!revokeToken(token[1]!)) return json({ error: "Unknown token." }, 404);
      return json({ revoked: true });
    }
    if (url.pathname === "/api/access/labels") {
      const target = req.method === "PUT" ? await body(req) : { kind: url.searchParams.get("kind"), id: url.searchParams.get("id") };
      const { kind, id } = record(target);
      if (req.method === "PUT") {
        const tier = (TIERS as readonly unknown[]).indexOf(target.tier);
        if (tier < 0) throw new Error(`tier must be one of ${TIERS.join(", ")}.`);
        setLabel(sdk.database, kind, id, "manual", tier, { reason: typeof target.reason === "string" ? target.reason.slice(0, 300) : "Set in the web interface" });
      } else if (req.method === "DELETE") clearLabel(sdk.database, kind, id, "manual");
      else if (req.method !== "GET") return json({ error: "Method not allowed." }, 405);
      const effective = recordTier(sdk.database, readAccessPolicy(), kind, id);
      return json({ kind, id, tier: effective === undefined ? null : TIERS[effective], labels: listLabels(sdk.database, kind, id) });
    }
    return json({ error: "Unknown access endpoint." }, 404);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Access request failed." }, 400);
  }
}
