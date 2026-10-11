import type { BrowserExtensionSettings } from "./settings.types";

export interface FilterResult {
  allowed: boolean;
  reason?: string;
  cleanUrl: string;
  domain: string;
  pathname: string;
}

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_name",
  "fbclid",
  "gclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "ref",
  "_hsenc",
  "_hsmi",
  "igshid",
  // Ephemeral Google search tracking and transient session parameters
  "fbs",
  "mstk",
  "ved",
  "sxsrf",
  "aep",
  "ntc",
  "aioh",
  "csuir",
  "cs",
  "mtid",
  "sourceid",
  "ei",
  "sei",
  "gs_lcrp",
  "oq",
  "sca_esv",
  "bshm",
  "biw",
  "bih",
  "dpr",
  "client",
  // Social and share tracking
  "si",
  "feature",
  "session_id",
]);

/** Google search presentation params split one query into several page identities. */
const GOOGLE_NOISE_PARAMS = new Set([
  "ie",
  "oe",
  "udm",
  "sa",
  "gs_lp",
  "sclient",
  "uact",
  "iflsig",
  "rlz",
  "lei",
  "newwindow",
]);
const GOOGLE_HOST = /(?:^|\.)google\.[a-z]{2,3}(?:\.[a-z]{2})?$/;

/**
 * Normalizes a URL by stripping tracking parameters, hash fragments, and standardizing hostnames.
 */
export function normalizeUrl(rawUrl: string): {
  cleanUrl: string;
  domain: string;
  pathname: string;
  isValid: boolean;
  protocol: string;
} {
  try {
    const parsed = new URL(rawUrl.trim());
    const protocol = parsed.protocol.toLowerCase();

    if (protocol !== "http:" && protocol !== "https:") {
      return {
        cleanUrl: rawUrl,
        domain: "",
        pathname: "",
        isValid: false,
        protocol,
      };
    }

    const domain = parsed.hostname.toLowerCase().replace(/^\.+|\.+$/g, "");

    // Strip tracking parameters
    const google = GOOGLE_HOST.test(domain);
    const keysToRemove: string[] = [];
    for (const key of parsed.searchParams.keys()) {
      const lowerKey = key.toLowerCase();
      if (
        TRACKING_PARAMS.has(lowerKey) ||
        lowerKey.startsWith("utm_") ||
        lowerKey.startsWith("fb_") ||
        (google && GOOGLE_NOISE_PARAMS.has(lowerKey))
      ) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      parsed.searchParams.delete(key);
    }

    // Strip hash fragments; SPA routes stay, but Chrome text-highlight directives never do.
    const route = /^#(?:!\/|\/)/.test(parsed.hash)
      ? parsed.hash.replace(/:~:.*$/, "")
      : "";
    parsed.hash = route;

    return {
      cleanUrl: parsed.toString(),
      domain,
      pathname: parsed.pathname,
      isValid: true,
      protocol,
    };
  } catch {
    return {
      cleanUrl: rawUrl,
      domain: "",
      pathname: "",
      isValid: false,
      protocol: "",
    };
  }
}

/** Graph identity for a URL; invalid or non-web URLs are returned unchanged. */
export function canonicalUrl(rawUrl: string): string {
  return normalizeUrl(rawUrl).cleanUrl;
}

/**
 * Checks if a hostname matches any domain in the exclusion list.
 * Matches exact hostname or any subdomain (e.g. "sub.reddit.com" matches "reddit.com").
 */
export function matchesExcludeDomains(
  hostname: string,
  excludeDomains: string[],
): boolean {
  if (!hostname || !excludeDomains || excludeDomains.length === 0) {
    return false;
  }

  const host = hostname.toLowerCase();
  for (const rawEx of excludeDomains) {
    const ex = rawEx.trim().toLowerCase();
    if (!ex) continue;
    if (host === ex || host.endsWith("." + ex)) {
      return true;
    }
  }
  return false;
}

/**
 * Converts a wildcard string (e.g. "*mail.google.com*") into a RegExp.
 */
function wildcardToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(escaped, "i");
}

/**
 * Checks if a URL or hostname matches any pattern in the exclusion list.
 */
export function matchesExcludePatterns(
  urlOrHost: string,
  excludePatterns: string[],
): boolean {
  if (!urlOrHost || !excludePatterns || excludePatterns.length === 0) {
    return false;
  }

  for (const rawPattern of excludePatterns) {
    const pattern = rawPattern.trim();
    if (!pattern) continue;

    try {
      const regex = wildcardToRegex(pattern);
      if (regex.test(urlOrHost)) {
        return true;
      }
    } catch {
      if (urlOrHost.toLowerCase().includes(pattern.toLowerCase())) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Evaluates whether a URL should be ingested based on configuration settings.
 */
export function evaluateUrl(
  rawUrl: string,
  settings: Partial<BrowserExtensionSettings>,
): FilterResult {
  const norm = normalizeUrl(rawUrl);

  if (!norm.isValid) {
    return {
      allowed: false,
      reason: `Unsupported protocol (${norm.protocol || "invalid url"})`,
      cleanUrl: norm.cleanUrl,
      domain: norm.domain,
      pathname: norm.pathname,
    };
  }

  // Check domain exclusion (e.g. social media)
  const excludeDomains = settings.excludeDomains ?? [];
  if (matchesExcludeDomains(norm.domain, excludeDomains)) {
    return {
      allowed: false,
      reason: `Domain "${norm.domain}" is in excludeDomains list`,
      cleanUrl: norm.cleanUrl,
      domain: norm.domain,
      pathname: norm.pathname,
    };
  }

  // Check pattern exclusion (e.g. privacy, banking, login)
  const excludePatterns = settings.excludePatterns ?? [];
  if (
    matchesExcludePatterns(norm.cleanUrl, excludePatterns) ||
    matchesExcludePatterns(norm.domain, excludePatterns)
  ) {
    return {
      allowed: false,
      reason: `URL matches excludePatterns rule`,
      cleanUrl: norm.cleanUrl,
      domain: norm.domain,
      pathname: norm.pathname,
    };
  }

  return {
    allowed: true,
    cleanUrl: norm.cleanUrl,
    domain: norm.domain,
    pathname: norm.pathname,
  };
}
