import { MEMORY_LIMITS, type PreparedSnippet, type PreparedSourceMemory } from "../../lib/memory/types";
import { validateMemory } from "../../lib/memory/prepare";
import { textSpan } from "../../lib/memory/text-span";
import type { VideoMetadata } from "./contract";
import { videoUrl } from "./contract";
import { playedSeconds } from "./progress";
import { metadataOf, rangesOf, type VideoRow } from "./store";
import type { TranscriptSynthesis } from "./summarize";

function descriptionSnippets(description: string): PreparedSnippet[] {
  const snippets: PreparedSnippet[] = [];
  for (let offset = 0; offset < description.length;) {
    const prefix = description.length > MEMORY_LIMITS.snippet ? `Description (part ${snippets.length + 1}):\n` : "";
    const span = textSpan(description, offset, Math.min(description.length, offset + MEMORY_LIMITS.snippet - prefix.length));
    if (span.text.trim()) snippets.push({ text: prefix + span.text, kind: "excerpt", purpose: "video description",
      locator: { kind: "youtube_description", start: span.start, end: span.end } });
    offset = span.end;
  }
  return snippets;
}

export function summaryBudget(metadata: VideoMetadata) {
  const description = descriptionSnippets(metadata.description);
  return { slots: MEMORY_LIMITS.snippets - 1 - description.length,
    characters: MEMORY_LIMITS.snippetCharacters - MEMORY_LIMITS.snippet - description.reduce((n, snippet) => n + snippet.text.length, 0) };
}

export function videoMemory(row: VideoRow, synthesis?: TranscriptSynthesis): PreparedSourceMemory {
  const metadata = metadataOf(row), played = playedSeconds(rangesOf(row), metadata.duration);
  const lines = [metadata.title, videoUrl(row.video_id), `Channel: ${metadata.channel.name}`,
    metadata.channel.id ? `Channel ID: ${metadata.channel.id}` : "", metadata.channel.url ?? "",
    `Duration: ${metadata.duration} seconds`, `Unique playback: ${played.toFixed(1)} seconds (${(100 * played / metadata.duration).toFixed(1)}%)`,
    `First watched: ${new Date(row.first_watched_at).toISOString()}`, `Last watched: ${new Date(row.last_watched_at).toISOString()}`,
    metadata.publishedAt ? `Published: ${metadata.publishedAt}` : "", metadata.category ? `Category: ${metadata.category}` : "",
    metadata.viewCount === undefined ? "" : `Views: ${metadata.viewCount}`, metadata.likeCount === undefined ? "" : `Likes: ${metadata.likeCount}`,
    metadata.tags?.length ? `Tags: ${metadata.tags.join(", ")}` : "", metadata.thumbnail ? `Thumbnail: ${metadata.thumbnail}` : "",
    synthesis ? `Subtitles: ${synthesis.language}${synthesis.generated ? " (automatic)" : " (creator)"}` : "",
  ].filter(Boolean).join("\n");
  const snippets: PreparedSnippet[] = [{ text: textSpan(lines, 0, MEMORY_LIMITS.snippet).text, kind: "excerpt",
    purpose: "video metadata", locator: { kind: "youtube_metadata", videoId: row.video_id } }, ...descriptionSnippets(metadata.description)];
  if (synthesis) {
    const budget = summaryBudget(metadata);
    const textOf = (section: TranscriptSynthesis["sections"][number]) => `${section.title}\n${section.text}`;
    const fits = synthesis.sections.length <= budget.slots
      && synthesis.sections.reduce((n, section) => n + textOf(section).length, 0) <= budget.characters;
    const count = Math.min(synthesis.sections.length, budget.slots);
    // Normally preserve the model's chosen detail allocation exactly. If a description changed
    // while enrichment was pending, distribute the cached sections across the reduced budget.
    const groups = Array.from({ length: count }, (_, i) => synthesis.sections.slice(
      Math.floor(i * synthesis.sections.length / count), Math.floor((i + 1) * synthesis.sections.length / count)));
    const allowance = Math.min(MEMORY_LIMITS.snippet, Math.floor(budget.characters / Math.max(1, count)));
    snippets.push(...groups.map(group => ({ text: fits ? textOf(group[0]!) : group.map(section =>
      textSpan(textOf(section), 0, Math.floor((allowance - 2 * (group.length - 1)) / group.length)).text).join("\n\n"),
      kind: "derived" as const, purpose: "transcript section summary", locator: {
        kind: "youtube_subtitles", transcriptId: synthesis.transcriptId, language: synthesis.language,
        generated: synthesis.generated, startSeconds: group[0]!.start, endSeconds: Math.max(...group.map(section => section.end)),
        url: `${videoUrl(row.video_id)}&t=${Math.floor(group[0]!.start)}s`,
      } })));
  }
  const memory: PreparedSourceMemory = {
    summary: synthesis?.summary ?? `Watched “${metadata.title}” by ${metadata.channel.name}. Unique playback covers ${(100 * played / metadata.duration).toFixed(1)}% of this ${metadata.duration}-second video.`,
    summaryMethod: synthesis ? "model" : "metadata", snippets,
    coverage: { inputCharacters: (synthesis?.inputCharacters ?? 0) + metadata.description.length + lines.length,
      sections: (synthesis?.cueCount ?? 0) + 2, summarizedSections: (synthesis?.sections.length ?? 0) + 2,
      method: synthesis ? "youtube-transcript-map-reduce" : "youtube-metadata" },
  };
  validateMemory(memory);
  return memory;
}
