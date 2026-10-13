/** Where each provider keeps conversations: URL shapes and the web app's own JSON endpoints. */
import { PROVIDERS, providerForUrl, type NormalizedConversation, type Provider } from "../contract";
import { normalizeChatGpt, type ChatGptConversation } from "../normalize/chatgpt";
import { normalizeClaude, type ClaudeConversation } from "../normalize/claude";
import { toMs } from "../normalize/time";

export interface ListedConversation { id: string; title: string; updatedAt: number }

export interface ApiProvider {
  home: string;
  conversationPath(id: string): string;
  /** One page of the conversation list, newest activity first. */
  listPath(offset: number, limit: number): string;
  parseList(data: unknown, limit: number): { items: ListedConversation[]; done: boolean };
  normalize(data: unknown, id: string): NormalizedConversation;
}

const PAGE = 100;

export const API_PROVIDERS: Record<"chatgpt" | "claude", ApiProvider> = {
  chatgpt: {
    home: "https://chatgpt.com/",
    conversationPath: id => `/backend-api/conversation/${encodeURIComponent(id)}`,
    listPath: (offset, limit) => `/backend-api/conversations?offset=${offset}&limit=${limit}&order=updated`,
    parseList(data, limit) {
      const body = data as { items?: Array<{ id?: string; title?: string; update_time?: unknown }>; total?: number; offset?: number };
      const items = (body.items ?? []).flatMap(item => item?.id
        ? [{ id: item.id, title: item.title ?? "", updatedAt: toMs(item.update_time) ?? 0 }] : []);
      const end = (body.offset ?? 0) + (body.items?.length ?? 0);
      return { items, done: (body.items?.length ?? 0) < limit || (body.total !== undefined && end >= body.total) };
    },
    normalize: (data, id) => normalizeChatGpt(data as ChatGptConversation, id),
  },
  claude: {
    home: "https://claude.ai/recents",
    conversationPath: id =>
      `/api/organizations/{org}/chat_conversations/${encodeURIComponent(id)}?tree=True&rendering_mode=messages&render_all_tools=true`,
    listPath: (offset, limit) => `/api/organizations/{org}/chat_conversations?limit=${limit}&offset=${offset}`,
    parseList(data, limit) {
      const rows = (Array.isArray(data) ? data : (data as { data?: unknown[] })?.data ?? []) as
        Array<{ uuid?: string; name?: string; updated_at?: string }>;
      const items = rows.flatMap(row => row?.uuid ? [{ id: row.uuid, title: row.name ?? "", updatedAt: toMs(row.updated_at) ?? 0 }] : [])
        .sort((a, b) => b.updatedAt - a.updatedAt);
      // Older Claude APIs ignore paging and return the whole list at once.
      return { items, done: rows.length < limit || rows.length > limit };
    },
    normalize: (data, id) => normalizeClaude(data as ClaudeConversation, id),
  },
};

export const LIST_PAGE_SIZE = PAGE;
export const isApiProvider = (provider: Provider): provider is "chatgpt" | "claude" => provider in API_PROVIDERS;

/** The provider and conversation id a tab URL points at, if it is an open conversation. */
export function conversationAt(url: string | undefined): { provider: Provider; conversationId: string } | undefined {
  if (!url) return undefined;
  const provider = providerForUrl(url);
  if (!provider) return undefined;
  const path = new URL(url).pathname;
  const match = provider === "chatgpt" ? path.match(/^(?:\/g\/[^/]+)?\/c\/([\w-]{4,200})/)
    : provider === "claude" ? path.match(/^\/chat\/([\w-]{4,200})/)
    : path.match(/^\/(?:u\/\d+\/)?(?:app|gem\/[^/]+)\/([\w-]{6,200})/);
  return match ? { provider, conversationId: match[1]! } : undefined;
}

export const hostPatterns = (provider: Provider) => PROVIDERS[provider].hosts.map(host => `https://${host}/*`);
