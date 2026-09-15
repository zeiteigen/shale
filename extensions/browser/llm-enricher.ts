import type { ShaleSDK } from "@shale/sdk";
import type {
  LLMPageAnalysis,
  LLMSessionAnalysis,
  SessionVisitRecord,
  WebPageData,
} from "./types";
import type { BrowserExtensionSettings } from "./settings.types";

/**
 * Cleans and parses JSON output from LLM chat completions.
 */
export function parseLLMJson<T>(rawText: string, fallback: T): T {
  try {
    let clean = rawText.trim();
    if (clean.startsWith("```")) {
      clean = clean.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    }
    return JSON.parse(clean) as T;
  } catch {
    return fallback;
  }
}

/**
 * Fallback page analysis if LLM call fails or returns non-JSON.
 */
export function buildFallbackPageAnalysis(
  title: string,
  domain: string,
  excerpt: string,
): LLMPageAnalysis {
  const words = title.split(/\s+/).filter((w) => w.length > 3);
  const topics = Array.from(
    new Set([domain, ...words.slice(0, 4).map((w) => w.replace(/[^\w]/g, ""))]),
  ).filter(Boolean);

  return {
    summary:
      excerpt.slice(0, 200).trim() ||
      `Web page from ${domain} titled "${title}".`,
    topics: topics.slice(0, 5),
    category: "WebPage",
  };
}

/**
 * Analyzes a single web page with LLM to produce a concise summary, key topics, and category.
 */
export async function analyzePageWithLLM(
  sdk: ShaleSDK,
  page: WebPageData,
  settings: Partial<BrowserExtensionSettings>,
): Promise<LLMPageAnalysis> {
  const maxChars = settings.maxContentChars ?? 3000;
  const excerpt = (page.textContent || "").slice(0, maxChars).trim();

  // If LLM analysis is disabled, use fast heuristic fallback
  if (settings.enableLlmAnalysis === false) {
    return buildFallbackPageAnalysis(page.title, page.domain, excerpt);
  }

  // If content is very short, use fallback without burning LLM tokens
  const minLength = settings.minContentLength ?? 100;
  if (excerpt.length < minLength) {
    return buildFallbackPageAnalysis(page.title, page.domain, excerpt);
  }

  const prompt = `You are a knowledge graph AI assistant.
Analyze the following web page content and produce a structured JSON analysis.

Title: "${page.title}"
Domain: "${page.domain}"
URL: "${page.cleanUrl}"
Content Excerpt:
${excerpt}

Task:
1. Provide a clear, factual 1-3 sentence summary of the page's core message or purpose.
2. Extract 3 to 5 key conceptual topics, tools, libraries, or entities covered.
3. Categorize the page into one of: "Documentation", "Tutorial", "Article", "Tool", "Reference", "Discussion", "News", or "General".

Return ONLY valid JSON matching this schema:
{
  "summary": "Concise 1-3 sentence summary.",
  "topics": ["topic1", "topic2", "topic3"],
  "category": "Documentation"
}`;

  try {
    const raw = await sdk.queryLLM(prompt, {
      model: settings.llmModel ?? undefined,
      maxTokens: 500,
    });

    const parsed = parseLLMJson<Partial<LLMPageAnalysis>>(raw, {});

    const summary =
      typeof parsed.summary === "string" && parsed.summary.trim()
        ? parsed.summary.trim()
        : excerpt.slice(0, 200).trim();

    const rawTopics = Array.isArray(parsed.topics)
      ? parsed.topics
          .map((t) => (typeof t === "string" ? t.trim() : ""))
          .filter(Boolean)
      : [];
    const topics = rawTopics.length > 0 ? rawTopics.slice(0, 6) : [page.domain];

    const category =
      typeof parsed.category === "string" && parsed.category.trim()
        ? parsed.category.trim()
        : "WebPage";

    return { summary, topics, category };
  } catch (err: any) {
    sdk.logger.warn(
      `LLM page analysis failed for "${page.title}": ${err?.message || err}. Using fallback.`,
    );
    return buildFallbackPageAnalysis(page.title, page.domain, excerpt);
  }
}

/**
 * Fallback session analysis if LLM is disabled or unavailable.
 */
export function buildFallbackSessionAnalysis(
  visits: SessionVisitRecord[],
): LLMSessionAnalysis {
  const domains = Array.from(new Set(visits.map((v) => v.domain))).filter(Boolean);
  const titles = visits.map((v) => v.title).filter(Boolean);
  const sessionTitle =
    titles.length > 0
      ? `Browsing Session: ${titles[0]}`
      : `Browsing Session (${domains.join(", ")})`;

  return {
    sessionTitle,
    summary: `Web browsing session spanning ${visits.length} page visits across ${domains.join(", ")}.`,
    topics: domains.slice(0, 5),
    dominantDomains: domains.slice(0, 5),
  };
}

/**
 * Synthesizes web activity within a single browsing session into a cohesive narrative summary.
 */
export async function synthesizeSessionWithLLM(
  sdk: ShaleSDK,
  visits: SessionVisitRecord[],
  settings: Partial<BrowserExtensionSettings>,
): Promise<LLMSessionAnalysis> {
  if (!visits || visits.length === 0) {
    return {
      sessionTitle: "Empty Session",
      summary: "No page visits recorded in session.",
      topics: [],
      dominantDomains: [],
    };
  }

  // If only 1 visit or LLM disabled, use heuristic fallback
  if (visits.length === 1 || settings.generateSessionSummaries === false) {
    return buildFallbackSessionAnalysis(visits);
  }

  const domains = Array.from(new Set(visits.map((v) => v.domain))).filter(Boolean);
  const pageListFormatted = visits
    .map(
      (v, idx) =>
        `${idx + 1}. [${v.domain}] "${v.title}" (${v.url})${
          v.transitionType ? ` via ${v.transitionType}` : ""
        }`,
    )
    .join("\n");

  const prompt = `You are a research workflow analyst and knowledge graph architect.
Analyze the sequence of web pages visited by a user during a single browsing session.

Visited Pages (in chronological order):
${pageListFormatted}

Task:
1. Formulate a descriptive, high-level session title that encapsulates the user's intent or research topic (e.g. "Investigating SQLite Vector Extensions in Bun").
2. Write a concise 2-4 sentence narrative summary synthesizing what the user investigated, tools/docs reviewed, and how the navigation flowed.
3. Identify 3 to 6 overarching topics or technologies explored across the whole session.
4. List the dominant domains.

Return ONLY valid JSON matching this schema:
{
  "sessionTitle": "Descriptive Session Title",
  "summary": "Narrative paragraph synthesizing the user's research workflow and conclusions.",
  "topics": ["topic1", "topic2", "topic3"],
  "dominantDomains": ["domain1.com", "domain2.org"]
}`;

  try {
    const raw = await sdk.queryLLM(prompt, {
      model: settings.llmModel ?? undefined,
      maxTokens: 600,
    });

    const parsed = parseLLMJson<Partial<LLMSessionAnalysis>>(raw, {});

    const sessionTitle =
      typeof parsed.sessionTitle === "string" && parsed.sessionTitle.trim()
        ? parsed.sessionTitle.trim()
        : `Browsing Session: ${visits[0].title}`;

    const summary =
      typeof parsed.summary === "string" && parsed.summary.trim()
        ? parsed.summary.trim()
        : `Web browsing session spanning ${visits.length} pages across ${domains.join(", ")}.`;

    const rawTopics = Array.isArray(parsed.topics)
      ? parsed.topics
          .map((t) => (typeof t === "string" ? t.trim() : ""))
          .filter(Boolean)
      : [];
    const topics = rawTopics.length > 0 ? rawTopics.slice(0, 6) : domains;

    const dominantDomains = Array.isArray(parsed.dominantDomains)
      ? parsed.dominantDomains
          .map((d) => (typeof d === "string" ? d.trim() : ""))
          .filter(Boolean)
      : domains;

    return {
      sessionTitle,
      summary,
      topics,
      dominantDomains: dominantDomains.length > 0 ? dominantDomains : domains,
    };
  } catch (err: any) {
    sdk.logger.warn(
      `LLM session synthesis failed: ${err?.message || err}. Using fallback.`,
    );
    return buildFallbackSessionAnalysis(visits);
  }
}
