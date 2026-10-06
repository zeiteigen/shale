import type { AIClientOptions } from "../lib/ai/types";
import type { StateManager } from "./state";

/** Submitted file and batch IDs survive daemon restarts in extension-scoped SQLite state. */
export function modelBatchStore(state: StateManager): NonNullable<AIClientOptions["batchStore"]> {
  return {
    get: key => state.getJson(key),
    set: (key, value) => state.setJson(key, value),
    delete: key => { state.delete(key); },
  };
}
