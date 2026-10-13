import { afterEach, describe, expect, test } from "bun:test";
import { DiscordAPI, DiscordAPIError, DiscordBudgetExceeded } from "../extensions/discord/api";
import { parseAPIConversation, parseAPIMessage } from "../extensions/discord/parse-api";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("Discord REST client", () => {
  test("encodes repeated query values, applies token scheme and limits message pages", async () => {
    const seen: Array<{ url: string; auth: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get("Authorization")! });
      return Response.json([{ id: "m1" }, { id: "m2" }]);
    }) as typeof fetch;
    const api = new DiscordAPI("secret", "bot", { requests: 2, messages: 2, deadline: Date.now() + 5000 });
    expect(await api.messages("c/1", { before: "9", limit: 100 })).toHaveLength(2);
    expect(api.remainingMessages).toBe(0);
    expect(seen[0]!.url).toContain("channels/c%2F1/messages?before=9&limit=2");
    expect(seen[0]!.auth).toBe("Bot secret");
    await expect(api.messages("c", {})).rejects.toBeInstanceOf(DiscordBudgetExceeded);
  });

  test("counts failed calls and exposes retry time and explicit forbidden status", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ retry_after: 1.25, message: "slow down" }), { status: 429 })) as unknown as typeof fetch;
    const api = new DiscordAPI("token", "user", { requests: 1, messages: 2, deadline: Date.now() + 5000 });
    const before = Date.now();
    try { await api.get("users/@me"); throw new Error("expected rejection"); }
    catch (error) {
      expect(error).toBeInstanceOf(DiscordAPIError);
      expect((error as DiscordAPIError).status).toBe(429);
      expect((error as DiscordAPIError).retryAt).toBeGreaterThanOrEqual(before + 1200);
    }
    await expect(api.get("users/@me")).rejects.toBeInstanceOf(DiscordBudgetExceeded);
    globalThis.fetch = (async () => new Response("{}", { status: 403, statusText: "Forbidden" })) as unknown as typeof fetch;
    const forbidden = new DiscordAPI("token", "user", { requests: 1, messages: 1, deadline: Date.now() + 5000 });
    await expect(forbidden.get("channels/x/messages")).rejects.toMatchObject({ status: 403, retryAt: undefined });
  });

  test("parses channel parent, mentions, replies and self reactions only for matching account", () => {
    expect(parseAPIConversation({ id: "thread", type: 11, name: "topic", parent_id: "parent" }, { id: "g", name: "Guild" })).toMatchObject({ kind: "thread", parentId: "parent", server: { id: "g" } });
    const raw = {
      id: "m", channel_id: "c", type: 19, timestamp: "2025-01-01T00:00:00Z", content: "hello",
      author: { id: "u", username: "user", global_name: "Global" }, mentions: [{ id: "v" }],
      message_reference: { message_id: "prior", channel_id: "c" },
      reactions: [{ emoji: { name: "👍" }, count: 3, me: true }],
    };
    expect(parseAPIMessage(raw, ["me"], "me")).toMatchObject({ authorName: "Global", replyToId: "prior", mentionedUserIds: ["v"], reactedUserIds: ["me"], isSystem: undefined });
    expect(parseAPIMessage(raw, ["other"], "me")?.reactedUserIds).toBeUndefined();
    expect(parseAPIMessage({ ...raw, timestamp: "bad" }, ["me"], "me")).toBeNull();
  });

  test('treats search indexing 202 as retryable rather than a successful result',async()=>{
    globalThis.fetch=(async()=>Response.json({message:'Not indexed yet',retry_after:2},{status:202})) as unknown as typeof fetch;
    const api=new DiscordAPI('fake','user',{requests:1,messages:25,deadline:Date.now()+10000});
    await expect(api.get('guilds/100/messages/search')).rejects.toMatchObject({status:202,retryAt:expect.any(Number)});
  });
});
