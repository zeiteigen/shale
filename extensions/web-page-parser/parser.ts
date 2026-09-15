import type { ShaleSDK } from "@shale/sdk";
import type { ProcessFileResponse } from "../../lib/messages.types";
import type { WebPageParseRequest, WebPageParseResponse } from "./types";

function decodeHtml(value: string): string {
  return value.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
}

export function extractReadableText(html: string): string {
  return decodeHtml(html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/(?:p|div|article|section|h[1-6]|li|br|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim());
}

export function extractImageUrls(html: string, baseUrl: string, limit = 8): string[] {
  const urls = new Set<string>();
  for (const match of html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    try {
      const url = new URL(match[1], baseUrl).toString();
      if (/^https?:/i.test(url)) urls.add(url);
    } catch {}
    if (urls.size >= limit) break;
  }
  return [...urls];
}

export function chunkWebText(text: string, size = 1000): string[] {
  const paragraphs = text.split(/\n\s*\n/).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > size) { chunks.push(current); current = ""; }
    if (paragraph.length <= size) current = current ? `${current}\n\n${paragraph}` : paragraph;
    else for (const sentence of paragraph.match(/[^.!?]+(?:[.!?]+|$)/g) ?? [paragraph]) {
      if (current && current.length + sentence.length + 1 > size) { chunks.push(current); current = ""; }
      current = current ? `${current} ${sentence.trim()}` : sentence.trim();
    }
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [text.trim()].filter(Boolean);
}

export async function parseWebPage(sdk: ShaleSDK, request: WebPageParseRequest): Promise<WebPageParseResponse> {
  const settings = sdk.settings.getAll<{ chunkSize?: number; maxFetchChars?: number; maxImages?: number; enableLlmContext?: boolean; llmModel?: string | null }>();
  let html = request.html ?? "";
  let text = request.textContent?.trim() ?? "";
  if (!text && !html) {
    const response = await fetch(request.url);
    if (!response.ok) throw new Error(`Could not fetch page (${response.status})`);
    html = (await response.text()).slice(0, settings.maxFetchChars ?? 100000);
  }
  if (!text) text = extractReadableText(html);
  const title = request.title?.trim() || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, "").trim() || new URL(request.url).hostname;
  const maxImages = settings.maxImages ?? 8;
  const imageUrls = [...new Set([
    ...(request.imageUrls ?? []).filter((url) => /^https?:/i.test(url)),
    ...(html ? extractImageUrls(html, request.url, maxImages) : []),
  ])].slice(0, maxImages);
  const chunks = chunkWebText(text, request.chunkSize ?? settings.chunkSize ?? 1000);
  let contextualSummary = `Web page “${title}” from ${new URL(request.url).hostname}. ${text.slice(0, 500)}`;
  if (settings.enableLlmContext !== false && text.length) {
    try {
      contextualSummary = (await sdk.queryLLM(`Write a concise retrieval context for this web page. State its subject, intended audience, and the relation between its main sections. Do not invent facts.\n\nTitle: ${title}\nURL: ${request.url}\n\nContent:\n${text.slice(0, 6000)}`, { model: settings.llmModel ?? undefined, maxTokens: 300 })).trim() || contextualSummary;
    } catch (error) { sdk.logger.warn(`Web-page contextualization failed for ${request.url}:`, error); }
  }
  const imageChunks: WebPageParseResponse["imageChunks"] = [];
  if (request.includeImages !== false && imageUrls.length) {
    for (const imageUrl of imageUrls) {
      try {
        const image = await sdk.messages.request<ProcessFileResponse>("file:process", { filePath: imageUrl, fileType: "image", contextEntity: title, options: { deferEmbedding: true } }, { target: "process-image" });
        if (image.success) imageChunks.push(...image.chunks.map((chunk) => ({
          text_content: chunk.text_content,
          chunk_type: chunk.chunk_type,
        })));
      } catch (error) { sdk.logger.debug(`Image parser unavailable or failed for ${imageUrl}: ${String(error)}`); }
    }
  }
  return { title, text, chunks, contextualSummary, imageUrls, imageChunks };
}
