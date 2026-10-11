import type { ShaleSDK } from "../sdk";
import type { Claim, ClaimFilter } from "../sdk/graph/types";

/**
 * Event participation (timelines live in graph_events) and single-hub memberships implied by the
 * namespace (one vault, one directory) turn the map into star clusters without adding structure.
 */
export const MAP_HIDDEN_PREDICATES = ["ROLE:*", "IN_VAULT", "IN_DIRECTORY"];
export const MAP_HIDDEN_TYPES = new Set(["Event", "Vault", "Directory"]);

/** Literal metadata must not consume the map's relationship budget. */
export function graphEdges(sdk: ShaleSDK, filter: ClaimFilter, maximum = 10_000) {
  const claims: Claim[] = [];
  const selection: ClaimFilter = { ...filter, objectOnly: true,
    excludePredicates: filter.excludePredicates ?? MAP_HIDDEN_PREDICATES,
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
