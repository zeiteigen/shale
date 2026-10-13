const STANDALONE_TOPIC_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "best",
  "by",
  "for",
  "from",
  "how",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "same",
  "search",
  "the",
  "to",
  "vs",
  "what",
  "with",
]);

function comparable(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/** App-chrome page titles that LLMs and title heuristics mistake for subjects. */
const UI_CHROME_TOPICS = new Set([
  "home",
  "homepage",
  "home page",
  "course home",
  "dashboard",
  "upgrade",
  "pricing",
  "plans",
  "billing",
  "api keys",
  "api key",
  "account",
  "my account",
  "account settings",
  "settings",
  "preferences",
  "profile",
  "notifications",
  "inbox",
  "login",
  "log in",
  "sign in",
  "sign up",
  "signup",
  "register",
  "logout",
  "log out",
  "new session",
  "new chat",
  "new tab",
  "new conversation",
  "untitled",
  "welcome",
  "loading",
  "page not found",
  "not found",
  "404",
  "error",
]);

/** True for labels that name a screen of an app rather than a subject. */
export function isUiChromeTopic(value: string): boolean {
  return UI_CHROME_TOPICS.has(comparable(cleanTopic(value)));
}

/** Topics equal to a thread or page label duplicate that node under another type. */
export function sameLabel(a: string, b: string): boolean {
  return comparable(cleanTopic(a)) === comparable(cleanTopic(b));
}

/** Stable graph identity for a page. Titles are display metadata, not identifiers. */
export function pageEntityName(cleanUrl: string): string {
  return cleanUrl;
}

/** Stable graph identity for a session, independent of an LLM-generated title. */
export function sessionEntityName(sessionId: string): string {
  return `browser-session://${sessionId}`;
}

/** Full SHA-256 IDs avoid collisions between URLs sharing a long common prefix. */
export function browserSourceId(prefix: string, identity: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(identity);
  return `${prefix}:${hasher.digest("hex")}`;
}

export function historySourceUri(cleanUrl: string): string {
  return `browser-history:${cleanUrl}`;
}

export function bookmarkSourceUri(bookmarkId: string, cleanUrl: string): string {
  return `browser-bookmark:${encodeURIComponent(bookmarkId)}:${cleanUrl}`;
}

function cleanTopic(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Keeps graph topics conceptual and rejects domains, URLs, title duplicates,
 * stopwords, and low-information fragments produced by heuristic/LLM output.
 */
export function sanitizeTopics(
  candidates: readonly unknown[],
  options: { title?: string; domain?: string; max?: number } = {},
): string[] {
  const title = comparable(options.title ?? "");
  const domain = comparable(options.domain ?? "");
  const seen = new Set<string>();
  const topics: string[] = [];

  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const topic = cleanTopic(candidate);
    const key = comparable(topic);
    if (!key || key === title || key === domain || seen.has(key)) continue;
    if (topic.length > 100 || topic.split(/\s+/).length > 10) continue;
    if (/^(?:https?:\/\/|www\.)/i.test(topic) || /^[\w.-]+\.[a-z]{2,}$/i.test(topic)) continue;
    if (STANDALONE_TOPIC_STOPWORDS.has(key) || UI_CHROME_TOPICS.has(key)) continue;
    if (/^\d+$/.test(topic)) continue;
    if (topic.length < 3 && !/^(?:ai|c\+\+)$/i.test(topic)) continue;

    seen.add(key);
    topics.push(topic);
    if (topics.length >= (options.max ?? 6)) break;
  }

  return topics;
}

/** A single useful fallback concept is better than one node per title token. */
export function topicFromPageTitle(title: string): string | null {
  const topic = cleanTopic(
    title
      .replace(/\s+[-|·•–—]\s+(?:Google Search|Google Gemini|Bing|DuckDuckGo)$/i, "")
      // Site suffixes: "Repo · GitHub", "Docs – MDN", "Post | Blog".
      .replace(/\s+[-|·•–—]\s+[^-|·•–—]{1,40}$/i, ""),
  );
  if (!topic || topic.length < 3 || topic.length > 100) return null;
  return topic;
}
