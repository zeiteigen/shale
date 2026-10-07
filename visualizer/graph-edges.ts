import type { ShaleSDK } from "../sdk";
import type { Claim, ClaimFilter } from "../sdk/graph/types";

/** Literal metadata must not consume the map's relationship budget. */
export function graphEdges(sdk: ShaleSDK, filter: ClaimFilter, maximum = 10_000) {
  const claims: Claim[] = [];
  const selection: ClaimFilter = { ...filter, objectOnly: true,
    statuses: filter.statuses ?? ["accepted", "proposed", "disputed"], polarity: 1 };
  while (claims.length < maximum) {
    const limit = Math.min(1000, maximum - claims.length);
    const page = sdk.graph.claims.list({ ...selection, offset: claims.length, limit });
    claims.push(...page);
    if (page.length < limit) return { claims, truncated: false };
  }
  const more = sdk.graph.claims.list({ ...selection, offset: maximum, limit: 1 });
  return { claims, truncated: more.length > 0 };
}
