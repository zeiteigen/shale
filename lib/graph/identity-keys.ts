export interface IdentityKey {
  kind: string;
  value: string;
}

export const STRONG_KEY_KINDS = new Set([
  "url",
  "github",
  "gitlab",
  "linkedin",
  "email",
  "discord-guild",
  "discord-user",
  "external",
  "handle",
]);
export const AFFILIATION_KEY_KINDS = new Set(["domain", "email-domain"]);

const STOPWORDS = new Set([
  "of",
  "the",
  "and",
  "for",
  "at",
  "in",
  "on",
  "a",
  "an",
  "to",
  "&",
]);
/** Words that decorate an organization's name without distinguishing it. */
const GENERIC = new Set([
  "club",
  "team",
  "society",
  "inc",
  "llc",
  "ltd",
  "corp",
  "corporation",
  "company",
  "co",
  "group",
  "association",
  "org",
  "organization",
  "organisation",
  "the",
  "official",
  "community",
  "server",
  "discord",
]);
const WEBMAIL = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
  "aol.com",
  "msn.com",
  "gmx.com",
  "mail.com",
  "yandex.com",
  "qq.com",
]);
const MULTI_PART_SUFFIXES = new Set([
  "co.uk",
  "ac.uk",
  "org.uk",
  "com.au",
  "edu.au",
  "co.in",
  "co.jp",
  "com.br",
  "co.nz",
]);
const GITHUB_RESERVED = new Set([
  "settings",
  "features",
  "topics",
  "marketplace",
  "explore",
  "notifications",
  "login",
  "about",
  "pricing",
  "sponsors",
  "search",
  "new",
  "pulls",
  "issues",
  "codespaces",
  "trending",
  "collections",
  "join",
  "organizations",
  "apps",
  "enterprise",
  "security",
  "site",
  "contact",
  "readme",
  "dashboard",
]);

/** Unicode-folded, lower-cased words of a label. */
export function words(label: string): string[] {
  return label
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}&]+/u)
    .filter(Boolean);
}

const compact = (parts: string[]) => parts.join("").replace(/&/g, "");

export function nameKeys(label: string): string[] {
  const all = label
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  if (!all.length) return [];
  const keys = new Set([all.join("")]);
  const distinctive = all.filter((word) => !GENERIC.has(word));
  if (distinctive.length && distinctive.length < all.length)
    keys.add(distinctive.join(""));
  return [...keys].filter((key) => key.length >= 2);
}

/**
 * `acronym:` key. Long names contribute their initials ("Northbridge High Performance Computing" → nhpc);
 * short all-caps style names contribute themselves, so both sides of an expansion meet on one key.
 */
export function acronymKeys(label: string): string[] {
  const raw = label
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .split(/[^\p{L}\p{N}&]+/u)
    .filter(Boolean);
  const significant = raw.filter(
    (word) =>
      !STOPWORDS.has(word.toLowerCase()) && !GENERIC.has(word.toLowerCase()),
  );
  const keys = new Set<string>();
  const shortForm = compact(significant).toLowerCase();
  // An existing abbreviation: one or two tokens, mostly upper case or very short.
  if (
    significant.length &&
    significant.length <= 3 &&
    shortForm.length >= 3 &&
    shortForm.length <= 8 &&
    (significant.length > 1 || /\p{Lu}{2}/u.test(significant[0]!)) &&
    significant.every((word) => word === word.toUpperCase() || word.length <= 4)
  )
    keys.add(shortForm);
  if (significant.length >= 3) {
    const initials = significant
      .map((word) =>
        word === word.toUpperCase() && word.length <= 4 ? word : word[0]!,
      )
      .join("")
      .toLowerCase();
    if (initials.length >= 3 && initials.length <= 8) keys.add(initials);
  }
  return [...keys];
}

export function registrableDomain(host: string): string {
  const parts = host
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.$/, "")
    .split(".");
  if (parts.length <= 2) return parts.join(".");
  const lastTwo = parts.slice(-2).join(".");
  return MULTI_PART_SUFFIXES.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
}

const TRACKING =
  /^(utm_.*|fbclid|gclid|dclid|msclkid|mc_[a-z]+|igshid|ref|ref_src|ref_url|source|si|spm|_ga|_gl|yclid)$/i;

/**
 * A stable URL key: scheme-less, host without www, no trailing slash or plain fragment, tracking parameters
 * dropped and the rest sorted. Query parameters often name the thing itself (item?id=…, watch?v=…).
 */
export function urlKey(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // The port distinguishes local apps (localhost:3000 vs localhost:5173); default ports are already omitted.
  const host = url.host.toLowerCase().replace(/^www\./, "");
  let path = url.pathname.replace(/\/+$/, "");
  if (/(^|\.)github\.com$|(^|\.)gitlab\.com$/.test(host))
    path = path.toLowerCase();
  const params = [...url.searchParams]
    .filter(([name]) => !TRACKING.test(name))
    .filter(([name]) => !(/(^|\.)youtube\.com$/.test(host) && name !== "v"))
    .sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
  const query = params.length
    ? `?${params.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join("&")}`
    : "";
  // Single-page-app routes (#/route, #!/route) name distinct pages, as the browser connector keeps them.
  const route = /^#!?\//.test(url.hash)
    ? url.hash.replace(/:~:.*$/, "").replace(/\/+$/, "")
    : "";
  return `${host}${path}${query}${route}`;
}

/** Name-like phrases in free text (runs of capitalised words, or all-caps tokens), for weak key lookups. */
export function namePhrases(text: string, limit = 40): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(
    /(?:\b(?:\p{Lu}[\p{L}\p{N}&'-]*|\p{Lu}{2,}[\p{N}]*)(?:[ \t]+(?:of|the|and|for|de)?[ \t]*(?:\p{Lu}[\p{L}\p{N}&'-]*)){0,5})/gu,
  )) {
    const phrase = match[0].trim();
    if (phrase.length >= 3 && phrase.length <= 80) found.add(phrase);
    if (found.size >= limit) break;
  }
  return [...found];
}

/** Keys a URL contributes to whatever it identifies or belongs to. */
export function urlKeys(raw: string): IdentityKey[] {
  const key = urlKey(raw);
  if (!key) return [];
  const url = new URL(raw.trim());
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const segments = url.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
  const keys: IdentityKey[] = [{ kind: "url", value: key }];
  if (host === "github.com" || host === "gitlab.com") {
    const kind = host === "github.com" ? "github" : "gitlab";
    const owner = segments[0] === "orgs" ? segments[1] : segments[0];
    if (owner && !GITHUB_RESERVED.has(owner.toLowerCase())) {
      keys.push({ kind, value: owner.toLowerCase() });
      if (segments[0] !== "orgs" && segments[1])
        keys.push({ kind, value: `${owner}/${segments[1]}`.toLowerCase() });
    }
  } else if (
    host.endsWith("linkedin.com") &&
    ["in", "company", "school"].includes(segments[0] ?? "") &&
    segments[1]
  ) {
    keys.push({
      kind: "linkedin",
      value: `${segments[0]}/${segments[1]}`.toLowerCase(),
    });
  } else if (
    (host === "discord.com" || host === "discordapp.com") &&
    segments[0] === "channels" &&
    /^\d+$/.test(segments[1] ?? "")
  ) {
    keys.push({ kind: "discord-guild", value: segments[1]! });
  }
  keys.push({ kind: "domain", value: registrableDomain(host) });
  return keys;
}

export function emailKeys(address: string): IdentityKey[] {
  const clean = address
    .trim()
    .toLowerCase()
    .replace(/^mailto:/, "");
  const match = /^[^\s@<>]+@([^\s@<>]+\.[^\s@<>]+)$/.exec(clean);
  if (!match) return [];
  const domain = registrableDomain(match[1]!);
  return [
    { kind: "email", value: clean },
    ...(WEBMAIL.has(domain) ? [] : [{ kind: "email-domain", value: domain }]),
  ];
}

/** Every key for a labelled record. Weak keys come from its names; strong keys from its URLs, emails, and accounts. */
export function identityKeys(input: {
  names: string[];
  urls?: string[];
  emails?: string[];
  external?: Array<{ authority: string; id: string }>;
}): IdentityKey[] {
  const keys: IdentityKey[] = [];
  for (const name of input.names) {
    for (const value of nameKeys(name)) keys.push({ kind: "name", value });
    for (const value of acronymKeys(name))
      keys.push({ kind: "acronym", value });
  }
  for (const url of input.urls ?? []) keys.push(...urlKeys(url));
  for (const email of input.emails ?? []) keys.push(...emailKeys(email));
  for (const { authority, id } of input.external ?? [])
    keys.push({ kind: "external", value: `${authority}:${id}` });
  const seen = new Set<string>();
  return keys.filter((key) => {
    const id = `${key.kind}\u0000${key.value}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** Extract URLs and email addresses that appear in free text. */
export function textReferences(text: string): {
  urls: string[];
  emails: string[];
} {
  const urls = [
    ...new Set(
      [...text.matchAll(/https?:\/\/[^\s<>()"'`\]]+/g)].map((match) =>
        match[0].replace(/[.,;:!?]+$/, ""),
      ),
    ),
  ];
  const emails = [
    ...new Set(
      [...text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map(
        (match) => match[0].toLowerCase(),
      ),
    ),
  ];
  return { urls, emails };
}

export const keyScope = (kind: string) => `key:${kind}`;
export const isStrongKey = (kind: string) => STRONG_KEY_KINDS.has(kind);
