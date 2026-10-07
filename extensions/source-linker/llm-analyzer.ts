import type { ShaleSDK } from "@shale/sdk";
import { acceptedLink } from "./link-decision";
import { pairCheckpointId } from "./link-batch";
import { linkEvidence } from "./link-evidence";
import { linkContext } from "./link-context";
import type {
  SourceCandidatePair,
  LLMLinkAnalysis,
  DiscoveredLink,
} from "./types";

export interface LLMAnalyzerOptions {
  model?: string | null;
  contextChunksPerSource?: number;
  maxContentChars?: number;
  minLlmConfidence?: number;
  defaultRelation?: string;
  chatPromptTemplate?: string | null;
  enableEntityResolution?: boolean;
  minEntityConfidence?: number;
  maxEntityResolutionsPerPair?: number;
}

function cleanMentions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean),
  )].slice(0, 20);
}

/**
 * Parses and sanitizes JSON response from LLM chat completion.
 */
export function parseLLMResponse(
  rawText: string,
  defaultRelation: string = "RELATES_TO",
): LLMLinkAnalysis {
  try {
    let clean = rawText.trim();
    // Strip markdown code fences if model returned ```json ... ```
    if (clean.startsWith("```")) {
      clean = clean.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    }

    const parsed = JSON.parse(clean);
    const shouldLink = Boolean(parsed.shouldLink);
    const rawRelation =
      typeof parsed.relation === "string" ? parsed.relation.trim() : "";
    const relation =
      rawRelation && rawRelation.toUpperCase() !== "NONE"
        ? rawRelation.toUpperCase().replace(/\s+/g, "_")
        : defaultRelation;
    const reason =
      typeof parsed.reason === "string"
        ? parsed.reason.trim()
        : "Semantically related content identified by AI analysis.";
    const weight =
      typeof parsed.weight === "number" && !isNaN(parsed.weight)
        ? Math.max(0.0, Math.min(1.0, parsed.weight))
        : 0.8;

    const entityResolutions = Array.isArray(parsed.entityResolutions)
      ? parsed.entityResolutions.flatMap((item: any) => {
          const canonicalName =
            typeof item?.canonicalName === "string"
              ? item.canonicalName.trim()
              : "";
          const mentionsA = cleanMentions(item?.mentionsA);
          const mentionsB = cleanMentions(item?.mentionsB);
          if (!canonicalName || mentionsA.length + mentionsB.length === 0) {
            return [];
          }
          return [{
            canonicalName,
            entityType:
              typeof item.entityType === "string" && item.entityType.trim()
                ? item.entityType.trim()
                : "Entity",
            mentionsA,
            mentionsB,
            confidence:
              typeof item.confidence === "number" && Number.isFinite(item.confidence)
                ? Math.max(0, Math.min(1, item.confidence))
                : 0,
            reason:
              typeof item.reason === "string" && item.reason.trim()
                ? item.reason.trim()
                : "Mentions refer to the same entity.",
          }];
        })
      : [];

    return { shouldLink, relation, reason, weight, entityResolutions };
  } catch (err) {
    // If model failed to return strict JSON, attempt fallback regex extraction
    const shouldLink = /"shouldLink"\s*:\s*true/i.test(rawText);
    const relMatch = rawText.match(/"relation"\s*:\s*"([^"]+)"/i);
    const reasonMatch = rawText.match(/"reason"\s*:\s*"([^"]+)"/i);
    const weightMatch = rawText.match(/"weight"\s*:\s*([0-9.]+)/i);

    return {
      shouldLink,
      relation: relMatch ? relMatch[1].toUpperCase() : defaultRelation,
      reason: reasonMatch
        ? reasonMatch[1]
        : "Semantically related content identified by AI analysis.",
      weight: weightMatch ? parseFloat(weightMatch[1]) : 0.8,
      entityResolutions: [],
    };
  }
}

/**
 * Builds the analysis prompt for a candidate source pair.
 */
export function buildAnalysisPrompt(
  pair: SourceCandidatePair,
  excerptA: string,
  excerptB: string,
  customTemplate?: string | null,
): string {
  if (customTemplate) {
    return customTemplate
      .replace(/\{\{titleA\}\}/g, pair.sourceA.title)
      .replace(/\{\{contentA\}\}/g, excerptA)
      .replace(/\{\{titleB\}\}/g, pair.sourceB.title)
      .replace(/\{\{contentB\}\}/g, excerptB);
  }

  return `You are an expert knowledge graph architect.
Analyze the relationship between the two sources below, which were identified as potentially related via vector similarity (cosine score: ${pair.knnSimilarity.toFixed(3)}).

Source 1:
Title: "${pair.sourceA.title}"
Origin: "${pair.sourceA.origin}"
Type: "${pair.sourceA.type}"
Content:
${excerptA || "(No text content available)"}

Source 2:
Title: "${pair.sourceB.title}"
Origin: "${pair.sourceB.origin}"
Type: "${pair.sourceB.type}"
Content:
${excerptB || "(No text content available)"}

Task:
1. Determine whether Source 1 and Source 2 have a meaningful relationship and should be linked in the knowledge graph.
2. If YES, classify the relationship with a concise relation name. Examples:
   - "REFERENCES": One source mentions or cites concepts from the other.
   - "EXPANDS_UPON": One source provides deeper details, proofs, or extensions of the other.
   - "PREREQUISITE_FOR": Concepts in one source are foundational for understanding the other.
   - "COMPLEMENTS": Sources provide complementary aspects or applications of a shared subject.
   - "CONTRADICTS": Sources present contrasting or conflicting viewpoints.
   - "RELATES_TO": General semantic or conceptual relationship.
3. Provide a clear, concise 1-2 sentence reason explaining WHY they are linked and how their concepts connect.
4. Assign a weight score between 0.0 and 1.0 reflecting connection strength.
5. Resolve named-entity coreferences across the sources. Group only explicit mentions that clearly denote the same person, organization, project, product, place, or concept. Choose a stable canonical name, preserve exact mention strings by source, and explain the evidence. Do not invent absent entities.

Return valid JSON with this exact schema:
{
  "shouldLink": true,
  "relation": "RELATION_NAME",
  "reason": "1-2 sentence rationale explaining the link.",
  "weight": 0.85,
  "entityResolutions": [{
    "canonicalName": "Canonical entity name",
    "entityType": "Person|Organization|Project|Product|Place|Concept|Entity",
    "mentionsA": ["exact mention in Source 1"],
    "mentionsB": ["exact alias in Source 2"],
    "confidence": 0.95,
    "reason": "Why these mentions denote the same entity"
  }]
}
If no meaningful relationship exists, return:
{
  "shouldLink": false,
  "relation": "NONE",
  "reason": "Explanation of why they should not be linked.",
  "weight": 0.0,
  "entityResolutions": []
}`;
}

/**
 * Evaluates a candidate source pair with the LLM to classify their relationship and reason.
 * Saves results to a checkpoint for crash recovery.
 */
export async function analyzeSourcePairWithLLM(
  pair: SourceCandidatePair,
  sdk: ShaleSDK,
  options?: LLMAnalyzerOptions,
): Promise<DiscoveredLink | null> {
  const checkpointId = pairCheckpointId(pair);

  // Check if this pair was already evaluated in a prior uncommitted checkpoint
  const existingCp = sdk.checkpoint
    .getQueue<any>()
    .find((cp) => cp.id === checkpointId || cp.key === checkpointId);

  if (existingCp?.data?.analysis) {
    const cached = existingCp.data;
    sdk.logger.debug(
      `Reusing checkpointed LLM analysis for "${pair.sourceA.title}" <-> "${pair.sourceB.title}"`,
    );

    return acceptedLink(cached, sdk);
  }

  const chunksCount =
    options?.contextChunksPerSource ??
    sdk.settings.get<number>("contextChunksPerSource") ??
    3;
  const maxChars =
    options?.maxContentChars ??
    sdk.settings.get<number>("maxContentChars") ??
    1500;
  const defaultRelation =
    options?.defaultRelation ??
    sdk.settings.get<string>("defaultRelation") ??
    "RELATES_TO";
  const minConfidence =
    options?.minLlmConfidence ??
    sdk.settings.get<number>("minLlmConfidence") ??
    0.5;
  const modelOverride =
    options?.model ?? sdk.settings.get<string>("llmModel");
  const enableEntityResolution =
    options?.enableEntityResolution ??
    sdk.settings.get<boolean>("enableEntityResolution") ??
    true;
  const minEntityConfidence =
    options?.minEntityConfidence ??
    sdk.settings.get<number>("minEntityConfidence") ??
    0.7;
  const maxEntityResolutions =
    options?.maxEntityResolutionsPerPair ??
    sdk.settings.get<number>("maxEntityResolutionsPerPair") ??
    10;

  const contextA = linkContext(sdk, pair.sourceA.id, pair.sourceA.hash, chunksCount);
  const contextB = linkContext(sdk, pair.sourceB.id, pair.sourceB.hash, chunksCount);

  const excerptA = contextA.combinedText.slice(0, maxChars);
  const excerptB = contextB.combinedText.slice(0, maxChars);
  const evidenceA = linkEvidence(sdk,pair.sourceA.id,pair.sourceA.hash,contextA.chunks,maxChars);
  const evidenceB = linkEvidence(sdk,pair.sourceB.id,pair.sourceB.hash,contextB.chunks,maxChars);

  const prompt = buildAnalysisPrompt(
    pair,
    excerptA,
    excerptB,
    options?.chatPromptTemplate ??
      sdk.settings.get<string>("chatPromptTemplate"),
  );

  sdk.logger.log(
    `Analyzing candidate pair via LLM: "${pair.sourceA.title}" <-> "${pair.sourceB.title}" (KNN: ${pair.knnSimilarity.toFixed(3)})`,
  );

  let rawResponse: string;
  try {
    rawResponse = await sdk.queryLLM(prompt, {
      model: modelOverride || undefined,
      responseFormat: { type: "json_object" },
      temperature: 0.1,
      reasoningEffort: "none",
      maxThinkingTokens: null,
      maxTokens: 8192,
    });
  } catch (err: any) {
    sdk.logger.error(
      `LLM query failed for pair "${pair.sourceA.title}" <-> "${pair.sourceB.title}":`,
      err?.message || err,
    );
    throw err;
  }

  const analysis = parseLLMResponse(rawResponse, defaultRelation);
  analysis.entityResolutions = enableEntityResolution
    ? analysis.entityResolutions
        .filter((resolution) => resolution.confidence >= minEntityConfidence)
        .slice(0, maxEntityResolutions)
    : [];

  // Save intermediate analysis to SQLite checkpoint for crash resilience
  sdk.saveCheckpoint(
    {
      sourceA: { id: pair.sourceA.id, title: pair.sourceA.title },
      sourceB: { id: pair.sourceB.id, title: pair.sourceB.title },
      analysis,
      accepted: analysis.shouldLink && analysis.weight >= minConfidence,
      knnSimilarity: pair.knnSimilarity,
      updatedAt: Math.max(pair.sourceA.updated_at, pair.sourceB.updated_at),
      evidenceA,evidenceB,extractionRun:checkpointId,model:modelOverride || sdk.llm.options?.().model,
    },
    {
      id: checkpointId,
      key: checkpointId,
    },
  );

  if (!analysis.shouldLink || analysis.weight < minConfidence) {
    sdk.logger.log(
      `Pair "${pair.sourceA.title}" <-> "${pair.sourceB.title}" rejected: ${analysis.reason}`,
    );
    return null;
  }

  sdk.logger.log(
    `Link established: "${pair.sourceA.title}" -[${analysis.relation}]-> "${pair.sourceB.title}" (score: ${analysis.weight.toFixed(2)}) Reason: ${analysis.reason}`,
  );

  return {
    sourceIdA: pair.sourceA.id,
    sourceTitleA: pair.sourceA.title,
    sourceIdB: pair.sourceB.id,
    sourceTitleB: pair.sourceB.title,
    relation: analysis.relation,
    reason: analysis.reason,
    weight: analysis.weight,
    knnSimilarity: pair.knnSimilarity,
    entityResolutions: analysis.entityResolutions,
    evidenceA,evidenceB,extractionRun:checkpointId,model:modelOverride || sdk.llm.options?.().model,
  };
}

export default analyzeSourcePairWithLLM;
