import type { ShaleSDK } from "@shale/sdk";
import { ENGINE_IDS, type Engine } from "./contract";
import { SEARCH_QUERIES_DEFAULTS, type SearchQueriesSettings } from "./settings.types";

export function searchSettings(sdk: ShaleSDK): SearchQueriesSettings {
  return sdk.settings.getAll<SearchQueriesSettings>();
}

export function enabledEngines(settings: SearchQueriesSettings): Engine[] {
  const listed = settings.engines ?? SEARCH_QUERIES_DEFAULTS.engines;
  return ENGINE_IDS.filter(engine => listed.includes(engine));
}
