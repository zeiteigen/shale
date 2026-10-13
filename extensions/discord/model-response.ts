/** Local models sometimes wrap otherwise valid structured output in a Markdown fence. */
export function parseModelObject(raw: string): Record<string, unknown> {
  const clean = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const value: unknown = JSON.parse(clean);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a model JSON object");
  return value as Record<string, unknown>;
}

export function parseRelevanceResponse(raw: string) {
  const value = parseModelObject(raw);
  if (typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 0 || value.score > 1
      || typeof value.reason !== "string" || !Array.isArray(value.participantIds)
      || value.participantIds.some(id => typeof id !== "string")) throw new Error("Invalid relevance model response");
  return { score: value.score, reason: value.reason.slice(0, 500), participantIds: value.participantIds as string[] };
}
