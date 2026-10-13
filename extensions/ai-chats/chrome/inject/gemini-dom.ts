/**
 * Reads the Gemini conversation open in this tab. Gemini has no usable history API, so this
 * scrapes the rendered turns. Every selector lives here, so a Gemini redesign is fixed in one file.
 * Only turns currently loaded in the page are returned; older ones may need scrolling first.
 */
const SELECTORS = {
  turn: "user-query, model-response",
  container: ".conversation-container, [id^='c_'], [data-turn-id]",
  userText: ".query-text, .query-content, [class*='query-text']",
  modelText: "message-content, .model-response-text, .markdown",
  title: "[data-test-id='conversation-title'], .conversation-title.selected, .selected .conversation-title, [aria-current='page'] .conversation-title",
  image: "img",
};

const clean = (text: string) => text.replace(/ /g, " ").replace(/\n{3,}/g, "\n\n").trim();
const safeId = (value: string) => value.replace(/[^\w.:@/+=-]/g, "_").slice(0, 160);

function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

export default function scrapeGemini() {
  const match = location.pathname.match(/^\/(?:u\/\d+\/)?(?:app|gem\/[^/]+)\/([\w-]{6,200})/);
  if (!match) return { error: "Not a Gemini conversation page" };
  const conversationId = match[1]!;
  const seen = new Map<string, number>();
  const messages = [...document.querySelectorAll<HTMLElement>(SELECTORS.turn)].flatMap(element => {
    const role = element.tagName.toLowerCase() === "user-query" ? "user" as const : "assistant" as const;
    const body = element.querySelector<HTMLElement>(role === "user" ? SELECTORS.userText : SELECTORS.modelText) ?? element;
    const text = clean(body.innerText || "");
    const attachments = [...element.querySelectorAll<HTMLImageElement>(SELECTORS.image)]
      .filter(img => img.naturalWidth > 64 || img.width > 64)
      .slice(0, 10)
      .map(img => ({ kind: "image" as const, name: (img.alt || "image").slice(0, 200) }));
    if (!text && !attachments.length) return [];
    const container = element.closest<HTMLElement>(SELECTORS.container);
    // Prefer Gemini's own turn id; otherwise hash the content, which survives re-renders.
    let base = container?.id || container?.dataset.turnId || `h${hash(`${role}\n${text}`)}`;
    base = safeId(`${base}:${role}`);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return [{ id: count ? `${base}:${count}` : base, role, text, attachments }];
  });
  const firstQuestion = messages.find(message => message.role === "user")?.text.replace(/\s+/g, " ").slice(0, 80);
  const title = clean(document.querySelector<HTMLElement>(SELECTORS.title)?.innerText || "")
    || (document.title && !/^(google )?gemini$/i.test(document.title.trim()) ? document.title.trim() : "")
    || firstQuestion || "Gemini chat";
  return { conversationId, title: title.slice(0, 500), url: location.href.split(/[?#]/)[0], messages };
}
