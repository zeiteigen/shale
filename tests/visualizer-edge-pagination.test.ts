import { expect, it } from "bun:test";
import { createExtensionSDK } from "../sdk";
import { createTestDatabase } from "./fixtures/database";
import { getGraphData } from "../visualizer/graph-data";
import { graphEdges } from "../visualizer/graph-edges";

it("shows relationships beyond the first claim page without spending its budget on literal metadata", () => {
  const database = createTestDatabase();
  const sdk = createExtensionSDK("map-test", { database });
  try {
    const a = sdk.graph.entities.create({ name: "A", type: "Topic" });
    const b = sdk.graph.entities.create({ name: "B", type: "Topic" });
    database.transaction(() => {
      for (let index = 0; index < 1100; index++)
        sdk.graph.claims.add({ subject: a.id, predicate: "PAGE_LOCATION", value: index });
      for (let index = 0; index < 1005; index++)
        sdk.graph.claims.add({ subject: a.id, predicate: "RELATES_TO", object: b.id, context: "research" });
    })();
    const graph = getGraphData(sdk, { context: "research" });
    expect(graph.edges).toHaveLength(1005);
    expect(graph.nodes.find(node => node.id === a.id)?.degree).toBe(1005);
    expect(graph.truncated).toBe(false);
    expect(getGraphData(sdk, { context: "absent" }).edges).toHaveLength(0);
    expect(graphEdges(sdk, { context: "research" }, 1005).truncated).toBe(false);
    expect(graphEdges(sdk, { context: "research" }, 1000).truncated).toBe(true);
    expect(sdk.graph.claims.list({ objectOnly: true, limit: 10 }).every(claim => claim.object === b.id)).toBe(true);
  } finally { database.close(); }
});
