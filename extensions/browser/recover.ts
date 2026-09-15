import type { CheckpointContext, ShaleSDK } from "@shale/sdk";
import { finalizePageVisit, type PreparedPageData } from "./ingest-processor";
import { buildSequentialEdges } from "./session-manager";
import type { BrowserExtensionSettings } from "./settings.types";

export interface RecoverResult {
  recoveredPages: number;
  recoveredSessions: number;
}

/**
 * Crash recovery runner invoked when queued checkpoints exist.
 * Embeds uncommitted summaries and commits sources, chunks, and graph edges without re-querying LLM.
 */
export async function run(
  sdk: ShaleSDK,
  context?: CheckpointContext,
): Promise<RecoverResult> {
  const ctx = context ?? sdk.getCheckpointContext();
  if (ctx.count === 0) {
    return { recoveredPages: 0, recoveredSessions: 0 };
  }

  sdk.logger.info(
    `[Recovery] Found ${ctx.count} queued checkpoint(s). Beginning recovery...`,
  );

  let recoveredPages = 0;
  let recoveredSessions = 0;
  let failed = 0;

  for (const item of ctx.checkpoints) {
    const data = item.data as any;
    if (!data || typeof data !== "object") {
      ctx.resolve(item.id);
      continue;
    }

    try {
      if (data.type === "browser_page_analysis") {
        const { pageData, analysis, namespace = sdk.namespace || "browser" } = data;
        if (!pageData || !analysis) {
          throw new Error("Malformed browser page checkpoint");
        }

        // Finalization is deliberately LLM-free. Reusing the normal Phase 2
        // path preserves HTML-derived chunks, links, images, and session edges.
        const prepared: PreparedPageData = {
          pageData,
          analysis,
          cleanUrl: pageData.cleanUrl || pageData.url,
          domain: pageData.domain || "",
          checkpointId: item.id,
          namespace,
          parsedChunks: data.parsedChunks,
          contextualSummary: data.contextualSummary,
          imageChunks: data.imageChunks,
        };
        await finalizePageVisit(
          sdk,
          prepared,
          sdk.settings.getAll<BrowserExtensionSettings>(),
        );
        recoveredPages++;
      } else if (data.type === "browser_session_analysis") {
        const {
          sessionId,
          startTime,
          endTime,
          visits,
          synthesis,
          namespace = sdk.namespace || "browser",
        } = data;

        const sessionText = [
          `Session: ${synthesis.sessionTitle}`,
          `Summary: ${synthesis.summary}`,
          `Topics: ${synthesis.topics.join(", ")}`,
          `Dominant Domains: ${synthesis.dominantDomains.join(", ")}`,
          `Pages Visited (${visits.length}):`,
          ...visits.map(
            (v: any, i: number) => `${i + 1}. [${v.domain}] ${v.title} (${v.url})`,
          ),
        ].join("\n");

        const embedding = await sdk.embed(sessionText);
        const sessionUri = `browser-session://${sessionId}`;

        sdk.ingest.sourceAndChunks({
          source: {
            id: `session:${sessionId}`,
            type: "web_session",
            uri: sessionUri,
            origin: "browser",
            title: synthesis.sessionTitle,
            created_at: startTime,
            updated_at: endTime,
          },
          chunks: [
            {
              chunk_index: 0,
              chunk_type: "synthetic",
              text_content: sessionText,
              embedding,
              entity_names: [synthesis.sessionTitle, ...synthesis.topics.slice(0, 3)],
            },
          ],
          namespace,
        });

        const entities: Array<{ name: string; type: string; namespace: string }> = [
          { name: synthesis.sessionTitle, type: "WebSession", namespace },
        ];
        for (const topic of synthesis.topics) {
          if (topic) entities.push({ name: topic, type: "Topic", namespace });
        }
        for (const domain of synthesis.dominantDomains) {
          if (domain) entities.push({ name: domain, type: "Domain", namespace });
        }

        const edges: Array<{
          source: string;
          target: string;
          relation: string;
          weight: number;
          metadata?: any;
        }> = [];

        for (let i = 0; i < visits.length; i++) {
          const v = visits[i];
          if (v.title) {
            entities.push({ name: v.title, type: "WebPage", namespace });
            edges.push({
              source: synthesis.sessionTitle,
              target: v.title,
              relation: "CONTAINS_PAGE",
              weight: 1.0,
              metadata: {
                visitOrder: i + 1,
                visitedAt: v.visitedAt,
                domain: v.domain,
                url: v.url,
              },
            });
          }
        }

        for (const topic of synthesis.topics) {
          edges.push({
            source: synthesis.sessionTitle,
            target: topic,
            relation: "COVERS_TOPIC",
            weight: 0.85,
          });
        }
        for (const domain of synthesis.dominantDomains) {
          edges.push({
            source: synthesis.sessionTitle,
            target: domain,
            relation: "PRIMARY_DOMAIN",
            weight: 0.8,
          });
        }

        const navEdges = buildSequentialEdges(visits);
        edges.push(...navEdges);

        sdk.graph.ingest({
          namespace,
          entities,
          edges,
        });

        recoveredSessions++;
      }

      ctx.resolve(item.id);
    } catch (err: any) {
      failed++;
      sdk.logger.error(
        `[Recovery] Failed recovering checkpoint ${item.id}: ${err?.message || err}`,
      );
    }
  }

  sdk.logger.info(
    `[Recovery] Finished. Recovered ${recoveredPages} page(s) and ${recoveredSessions} session(s).`,
  );

  // The host only removes all remaining checkpoint rows when this function
  // resolves successfully. Surface partial failures so failed work stays
  // queued for the next startup/cron retry.
  if (failed > 0) {
    throw new Error(`Browser checkpoint recovery failed for ${failed} item(s)`);
  }

  return { recoveredPages, recoveredSessions };
}

export default run;
