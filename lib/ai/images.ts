import type OpenAI from "openai";
import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import type { LLMImageInput, LLMImageDetail } from "./types";

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
};

/**
 * Normalizes varied image inputs (URL, local path, base64 data URL, Buffer) into an OpenAI ChatCompletionContentPart.
 */
export function normalizeImageContentPart(
  img: LLMImageInput,
): OpenAI.Chat.Completions.ChatCompletionContentPart {
  let url = "";
  let detail: LLMImageDetail | undefined;

  if (typeof img === "string") {
    if (
      img.startsWith("http://") ||
      img.startsWith("https://") ||
      img.startsWith("data:")
    ) {
      url = img;
    } else if (existsSync(img)) {
      const ext = extname(img).toLowerCase();
      const mime = MIME_TYPES[ext] || "image/jpeg";
      const b64 = readFileSync(img).toString("base64");
      url = `data:${mime};base64,${b64}`;
    } else {
      url = `data:image/jpeg;base64,${img}`;
    }
  } else if (img instanceof Uint8Array || Buffer.isBuffer(img)) {
    const b64 = Buffer.from(img).toString("base64");
    url = `data:image/jpeg;base64,${b64}`;
  } else if (typeof img === "object" && img !== null) {
    detail = img.detail;
    if (img.url) {
      if (
        img.url.startsWith("http://") ||
        img.url.startsWith("https://") ||
        img.url.startsWith("data:")
      ) {
        url = img.url;
      } else if (existsSync(img.url)) {
        const ext = extname(img.url).toLowerCase();
        const mime = MIME_TYPES[ext] || "image/jpeg";
        const b64 = readFileSync(img.url).toString("base64");
        url = `data:${mime};base64,${b64}`;
      } else {
        url = `data:image/jpeg;base64,${img.url}`;
      }
    } else if (img.path && existsSync(img.path)) {
      const ext = extname(img.path).toLowerCase();
      const mime = img.mimeType || MIME_TYPES[ext] || "image/jpeg";
      const b64 = readFileSync(img.path).toString("base64");
      url = `data:${mime};base64,${b64}`;
    } else if (img.data) {
      const mime = img.mimeType || "image/jpeg";
      const b64 =
        typeof img.data === "string"
          ? img.data
          : Buffer.from(img.data).toString("base64");
      url = b64.startsWith("data:") ? b64 : `data:${mime};base64,${b64}`;
    }
  }

  if (!url) {
    throw new Error("Invalid image input provided to LLM query.");
  }

  return {
    type: "image_url",
    image_url: detail ? { url, detail } : { url },
  };
}
