import { extractDocument } from "../lib/web-extraction";
/** Injection entrypoint returns data directly and never registers persistent listeners. */
(
  globalThis as typeof globalThis & { __shaleExtract: () => Promise<unknown> }
).__shaleExtract = async () => {
  await new Promise<void>((resolve) => {
    let settled: ReturnType<typeof setTimeout>;
    const finish = () => {
      observer.disconnect();
      clearTimeout(settled);
      clearTimeout(deadline);
      resolve();
    };
    const observer = new MutationObserver(() => {
      clearTimeout(settled);
      settled = setTimeout(finish, 250);
    });
    const deadline = setTimeout(finish, 1500);
    settled = setTimeout(finish, 300);
    if (document.body)
      observer.observe(document.body, { childList: true, subtree: true });
  });
  const snapshot = document.cloneNode(true) as Document;
  const original = [...document.querySelectorAll("*")],
    copied = [...snapshot.querySelectorAll("*")];
  for (let i = 0; i < Math.min(original.length, 3000); i++) {
    const node = original[i]!;
    if (["SCRIPT", "STYLE", "HEAD"].includes(node.tagName)) continue;
    const style = getComputedStyle(node);
    if (style.display === "none" || style.visibility === "hidden")
      copied[i]?.remove();
  }
  const extracted = extractDocument(snapshot, location.href, 60000);
  const title = (
    snapshot.querySelector("h1")?.textContent ||
    document.title ||
    location.href
  )
    .trim()
    .slice(0, 2000);
  const excerpt = (
    document
      .querySelector('meta[name="description"]')
      ?.getAttribute("content") || extracted.text.slice(0, 300)
  ).slice(0, 2000);
  const canonical = document
    .querySelector('link[rel="canonical"]')
    ?.getAttribute("href");
  let canonicalUrl: string | undefined;
  try {
    const candidate = new URL(canonical || "", location.href);
    if (candidate.origin === location.origin) canonicalUrl = candidate.href;
  } catch {}
  const { text, ...retained } = extracted;
  return {
    url: location.href,
    title,
    textContent: text || excerpt || title,
    excerpt,
    author: (
      document.querySelector('meta[name="author"]')?.getAttribute("content") ||
      ""
    ).slice(0, 500),
    favIconUrl:
      (document.querySelector('link[rel~="icon"]') as HTMLLinkElement)?.href ||
      "",
    canonicalUrl,
    ...retained,
  };
};
