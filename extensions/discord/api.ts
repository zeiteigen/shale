export interface DiscordBudget { requests: number; messages: number; deadline: number }

export class DiscordBudgetExceeded extends Error {
  constructor(message: string) { super(message); this.name = "DiscordBudgetExceeded"; }
}

export class DiscordAPIError extends Error {
  constructor(message: string, public status: number, public retryAt?: number) {
    super(message); this.name = "DiscordAPIError";
  }
}

export class DiscordAPI {
  private requests = 0;
  private messagesUsed = 0;

  constructor(
    private readonly token: string,
    private readonly kind: "user" | "bot",
    private readonly budget: DiscordBudget,
  ) {}

  get remainingMessages(): number {
    return Math.max(0, this.budget.messages - this.messagesUsed);
  }
  get remainingRequests(): number { return Math.max(0,this.budget.requests-this.requests); }

  consumeMessages<T>(messages: T[]): T[] {
    const accepted=messages.slice(0,this.remainingMessages);
    this.messagesUsed+=accepted.length;
    return accepted;
  }

  async get<T>(path: string, query?: Record<string, string | number | string[]>): Promise<T> {
    const remaining = this.budget.deadline - Date.now();
    if (remaining <= 0) throw new DiscordBudgetExceeded("Discord request deadline exceeded");
    if (this.requests >= this.budget.requests) throw new DiscordBudgetExceeded("Discord request budget exhausted");
    this.requests++;
    const url = new URL(path.replace(/^\/+/, ""), "https://discord.com/api/v10/");
    for (const [key, value] of Object.entries(query ?? {})) {
      for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, String(item));
    }
    const timeout = Math.min(30_000, remaining);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { Authorization: `${this.kind === "bot" ? "Bot " : ""}${this.token}` },
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      if (Date.now() >= this.budget.deadline) throw new DiscordBudgetExceeded("Discord request deadline exceeded");
      throw error;
    }
    if (response.ok && response.status !== 202) return await response.json() as T;
    let body: any = undefined;
    try { body = await response.clone().json(); } catch { /* response may have no JSON body */ }
    const retryAt = (response.status === 429 || response.status === 202) && Number.isFinite(Number(body?.retry_after))
      ? Date.now() + Math.max(0, Number(body.retry_after)) * 1000
      : undefined;
    const detail = typeof body?.message === "string" ? body.message : response.statusText || "Discord API request failed";
    throw new DiscordAPIError(detail, response.status, retryAt);
  }

  async messages(channelId: string, query: { before?: string; after?: string; around?: string; limit?: number } = {}): Promise<unknown[]> {
    const allowed = Math.min(100, this.remainingMessages);
    if (allowed <= 0) throw new DiscordBudgetExceeded("Discord message budget exhausted");
    const limit = Math.max(1, Math.min(allowed, Math.floor(query.limit ?? 100)));
    const result = await this.get<unknown>(`channels/${encodeURIComponent(channelId)}/messages`, { ...query, limit });
    if (!Array.isArray(result)) throw new DiscordAPIError("Discord returned a non-array message response", 200);
    return this.consumeMessages(result.slice(0,limit));
  }
}
