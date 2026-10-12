import type { ShaleSDK } from "@shale/sdk";
import type { ProcessFileResponse } from "../../lib/messages.types";
import type { WebPageParseRequest, WebPageParseResponse } from "./types";
import { isDecorativeImageUrl } from "../../lib/decorative-images";

import { parseHtmlSnapshot } from "./readability";
import { chunkBlocks } from "./chunk-blocks";
import { fetchPublicPage } from "./fetch-page";

export function extractReadableText(html: string): string {
  return parseHtmlSnapshot(html, "https://snapshot.invalid").text;
}
export function extractImageUrls(
  html: string,
  baseUrl: string,
  limit = 8,
): string[] {
  return parseHtmlSnapshot(html, baseUrl)
    .images.map((x) => x.url)
    .slice(0, limit);
}
export function chunkWebText(text: string, size = 1000): string[] {
  return chunkBlocks(
    [{ kind: "paragraph", text, locator: "text", headingPath: [] }],
    size,
  ).map((x) => x.text);
}

export async function parseWebPage(
  sdk: ShaleSDK,
  request: WebPageParseRequest,
  signal?: AbortSignal,
): Promise<WebPageParseResponse> {
  signal?.throwIfAborted();
  const settings = sdk.settings.getAll<{
    chunkSize?: number;
    maxFetchChars?: number;
    maxImages?: number;
    enableLlmContext?: boolean;
    llmModel?: string | null;
    allowFetch?: boolean;
  }>();
  let html = request.html ?? "";
  let text = request.textContent?.trim() ?? "";
  if (!text && !html && request.allowFetch === true) {
    if (settings.allowFetch === false)
      throw new Error("Public-page fetching is disabled");
    html = await fetchPublicPage(
      request.url,
      settings.maxFetchChars ?? 100000,
      signal,
    );
  }
  const candidate = html
    ? parseHtmlSnapshot(html, request.url, settings.maxFetchChars ?? 100000)
    : undefined;
  const preferHtml =
    !!candidate?.text &&
    (!text || (text.length < 100 && candidate.text.length > text.length * 2));
  if (preferHtml) text = candidate!.text;
  const blocks = preferHtml
    ? candidate!.blocks
    : request.blocks?.length
      ? request.blocks
      : [
          {
            kind: "paragraph" as const,
            text,
            locator: "text",
            headingPath: [],
          },
        ];
  const extraction = preferHtml
    ? candidate!.extraction
    : (request.extraction ?? {
        method: "supplied-text",
        version: "blocks-v1",
        quality: text.length >= 100 ? ("full" as const) : ("metadata" as const),
        truncated: false,
        originalChars: text.length,
        reasons: [],
      });
  const title =
    request.title?.trim() ||
    html
      .match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
      ?.replace(/<[^>]+>/g, "")
      .trim() ||
    new URL(request.url).hostname;
  const maxImages = settings.maxImages ?? 8;
  const imageUrls = [
    ...new Set([
      ...(request.imageUrls ?? []).filter((url) =>
        /^https?:/i.test(url) && !isDecorativeImageUrl(url)),
      ...(html ? extractImageUrls(html, request.url, maxImages) : []),
    ]),
  ].slice(0, maxImages);
  const located = chunkBlocks(
    blocks,
    request.chunkSize ?? settings.chunkSize ?? 1000,
  );
  const chunks = located.map((x) => x.text);
  let contextualSummary = `Web page “${title}” from ${new URL(request.url).hostname}. ${text.slice(0, 500)}`;
  let contextMethod = "excerpt";
  if (
    request.enableLlmContext !== false &&
    settings.enableLlmContext !== false &&
    text.length
  ) {
    try {
      contextualSummary =
        (
          await sdk.queryLLM(
            `Write a concise retrieval context for this web page. State its subject, intended audience, and the relation between its main sections. Do not invent facts.\n\nTitle: ${title}\nURL: ${request.url}\n\nContent:\n${text.slice(0, 6000)}`,
            { model: settings.llmModel ?? undefined, maxTokens: 300, signal },
          )
        ).trim() || contextualSummary;
      contextMethod = "llm";
    } catch (error) {
      signal?.throwIfAborted();
      sdk.logger.warn(
        `Web-page contextualization failed for ${request.url}:`,
        error,
      );
    }
  }
  const imageChunks: WebPageParseResponse["imageChunks"] = [];
  const imageKnowledge: NonNullable<WebPageParseResponse["imageKnowledge"]> =
    [];
  if (request.includeImages !== false && imageUrls.length) {
    for (const imageUrl of imageUrls) {
      try {
        const image = await sdk.messages.request<ProcessFileResponse>(
          "file:process",
          {
            filePath: imageUrl,
            fileType: "image",
            contextEntity: title,
          },
          { target: "process-image", timeoutMs: 300000, signal },
        );
        if (image.success) {
          const offset = imageChunks.length;
          imageKnowledge.push({
            uri: image.uri || imageUrl,
            title: image.title || imageUrl,
            claims: (
              image.knowledge ??
              image.chunks.map((chunk) => ({
                predicate: "VISUAL_DESCRIPTION",
                value: chunk.text_content,
                chunkIndex: chunk.chunk_index,
                status: "proposed" as const,
                method: "vision",
              }))
            ).map((claim) => ({
              ...claim,
              chunkIndex: claim.chunkIndex + offset,
            })),
          });
          imageChunks.push(
            ...image.chunks.map((chunk) => ({
              text_content: chunk.text_content,
              chunk_type: "synthetic" as const,
              metadata: {
                ...chunk.metadata,
                assetUri: image.uri || imageUrl,
                origin: "vision",
              },
            })),
          );
        }
      } catch (error) {
        signal?.throwIfAborted();
        sdk.logger.debug(
          `Image parser unavailable or failed for ${imageUrl}: ${String(error)}`,
        );
      }
    }
  }
  return {
    title,
    text,
    chunks,
    blocks,
    extraction,
    chunkLocators: located.map(({ locator, headingPath }) => ({
      locator,
      headingPath,
    })),
    contextualSummary,
    contextMethod,
    contextModel:
      contextMethod === "llm"
        ? (settings.llmModel ?? sdk.llm.options?.().model)
        : undefined,
    imageUrls,
    imageChunks,
    imageKnowledge,
  };
}
