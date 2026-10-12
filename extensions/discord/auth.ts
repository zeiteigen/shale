import type { AuthProvider, AuthStatus, ShaleSDK } from "@shale/sdk";
import { discordSettings } from "./connector";
import { DISCORD_DEFAULTS } from "./settings.types";
import { LAST_SYNC_KEY } from "./connector";

const API = "https://discord.com/api/v10";

export type DiscordTokenKind = "user" | "bot";

/** The stored token wins; the configured environment variable is a fallback for headless setups. */
export function discordToken(sdk: ShaleSDK): string | undefined {
  return sdk.credentials.resolve("token", discordSettings(sdk).tokenEnv || DISCORD_DEFAULTS.tokenEnv);
}

async function whoAmI(token: string, kind: DiscordTokenKind) {
  let response: Response;
  try {
    response = await fetch(`${API}/users/@me`, { headers: { Authorization: kind === "bot" ? `Bot ${token}` : token } });
  } catch (error) {
    throw new Error(`Could not reach Discord: ${error instanceof Error ? error.message : error}`);
  }
  if (response.status === 401) throw new Error("Discord rejected this token. Copy it again and make sure it is complete.");
  if (!response.ok) throw new Error(`Discord returned ${response.status} while checking the token.`);
  const user = await response.json() as { id: string; username: string; global_name?: string | null; bot?: boolean };
  if (kind === "bot" && !user.bot) throw new Error("This is a user token; choose the user token method instead.");
  return user;
}

function lastSync(sdk: ShaleSDK): string {
  const settings = discordSettings(sdk);
  if (settings.syncEnabled === false) return " Sync is turned off (syncEnabled).";
  const last = sdk.state.getJson<{ channels: number; skipped: number; messages: number; errors: number; finishedAt: number }>(LAST_SYNC_KEY);
  if (!last) return " The first sync runs on the next discord-sync cron (hourly), or run it now from Overview.";
  return ` Last sync ${new Date(last.finishedAt).toLocaleString()}: ${last.channels} channel(s), ${last.messages} new message(s)`
    + `${last.skipped ? `, ${last.skipped} without access` : ""}${last.errors ? `, ${last.errors} error(s) — see the logs` : ""}.`;
}

function status(sdk: ShaleSDK, error?: string): AuthStatus {
  const stored = sdk.credentials.all();
  if (stored.token) return {
    connected: true, account: stored.account, checkedAt: stored.checkedAt ? Number(stored.checkedAt) : undefined, error,
    detail: (stored.kind === "bot" ? "Bot token — syncs servers the bot has joined." : "User token — syncs your servers and DMs.") + lastSync(sdk),
  };
  const envName = discordSettings(sdk).tokenEnv || DISCORD_DEFAULTS.tokenEnv;
  if (process.env[envName]?.trim()) return { connected: true, account: `${envName} environment variable`, error,
    detail: `Using ${envName} from data/.env. Connect here to manage the token from the browser instead.` + lastSync(sdk) };
  return { connected: false, error };
}

async function connectToken(sdk: ShaleSDK, token: string, kind: DiscordTokenKind): Promise<AuthStatus> {
  // Strip a pasted "Bot " prefix or surrounding quotes.
  const clean = token.trim().replace(/^"|"$/g, "").replace(/^Bot\s+/i, "");
  const user = await whoAmI(clean, kind);
  sdk.credentials.set({ token: clean, kind, userId: user.id, account: user.global_name ? `${user.global_name} (@${user.username})` : `@${user.username}`,
    checkedAt: String(Date.now()) });
  return status(sdk);
}

export const auth: AuthProvider = {
  title: "Discord",
  description: "Used by the discord-sync cron to export new messages with DiscordChatExporter. Exports you drop into the import folder need no account.",
  warning: "Automating a user account is against Discord's Terms of Service. A bot token in servers you manage is the compliant option but cannot read DMs.",
  methods: [
    { id: "user", label: "User token", description: "Your account's token, from the browser's developer tools (Network tab → any request to discord.com → the Authorization header). Treat it like a password.",
      fields: [{ key: "token", label: "User token", type: "password", required: true }] },
    { id: "bot", label: "Bot token", description: "A bot from the Discord Developer Portal with the Message Content intent, added to your servers.",
      fields: [{ key: "token", label: "Bot token", type: "password", required: true }] },
  ],
  status: sdk => status(sdk),
  connect: (sdk, method, values) => connectToken(sdk, values.token!, method === "bot" ? "bot" : "user"),
  async verify(sdk) {
    const stored = sdk.credentials.all();
    const token = stored.token ?? discordToken(sdk);
    if (!token) return status(sdk, "No token is connected.");
    try {
      const user = await whoAmI(token, stored.kind === "bot" ? "bot" : "user");
      if (stored.token) sdk.credentials.set({ account: user.global_name ? `${user.global_name} (@${user.username})` : `@${user.username}`,
        userId: user.id, checkedAt: String(Date.now()) });
      return status(sdk);
    } catch (error) {
      return status(sdk, error instanceof Error ? error.message : String(error));
    }
  },
  disconnect: sdk => sdk.credentials.clear(),
};

export default auth;
