import type { ShaleSDK, CheckpointContext } from "@shale/sdk";
import { commitLinksToGraph } from "./process-links";
import { acceptedLink, type LinkCheckpoint } from "./link-decision";
import { completeLinkPairs, WATERMARK_KEY } from "./link-batch";
import type { DiscoveredLink } from "./types";

export interface RecoverResult {
  recoveredCount: number;
  edgesCommitted: number;
  watermarkAdvancedTo: number;
}

/** Commit cached decisions; only a completed durable batch can advance discovery. */
export async function run(
  sdk: ShaleSDK,
  contextOverride?: CheckpointContext,
): Promise<RecoverResult> {
  // The host invokes recovery before the cron runner; disabling the retired pipeline must cover both.
  if (sdk.settings.get<boolean>('enabled') === false) return {
    recoveredCount: 0, edgesCommitted: 0, watermarkAdvancedTo: Number(sdk.state.getWatermark(WATERMARK_KEY) ?? '0'),
  };
  const context = contextOverride ?? sdk.getCheckpointContext();
  const links: DiscoveredLink[] = [];
  const completed = new Set<string>();
  for (const cp of context.checkpoints) {
    if (!cp.id.startsWith("link_analysis:")) continue;
    const data = cp.data as LinkCheckpoint;
    if (!data?.analysis || !data.sourceA?.id || !data.sourceB?.id)
      throw new Error(`Malformed link checkpoint ${cp.id}; retained for retry`);
    const link = acceptedLink(data, sdk);
    if (link) links.push(link);
    completed.add(cp.id);
  }
  const namespace = sdk.settings.get<string>("namespace") ?? "source-linker";
  const bidirectional = sdk.settings.get<boolean>("bidirectional") ?? true;
  const edgesCommitted = sdk.database.transaction(() => {
    const edges = commitLinksToGraph(links, sdk, namespace, bidirectional);
    for (const id of completed) context.resolve(id);
    completeLinkPairs(sdk, completed);
    return edges;
  })();
  return {
    recoveredCount: links.length,
    edgesCommitted,
    watermarkAdvancedTo: Number(sdk.state.getWatermark(WATERMARK_KEY) ?? "0"),
  };
}

export default run;
