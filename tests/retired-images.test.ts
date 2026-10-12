import { afterEach, describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import { createExtensionSDK, createMessageBus, SourceGraph } from "../sdk";
import type { ClaimFilter, ClaimStatus } from "../sdk/graph/types";
import { getGraphData } from "../visualizer/graph-data";
import { createTestDatabase } from "./fixtures/database";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = createTestDatabase();
  databases.push(db);
  const sdk = createExtensionSDK("retired-images-test", { database: db, namespace: "browser", messageBus: createMessageBus() });
  sdk.ingest.sourceAndChunks({ source: { id: "page", uri: "https://example.com/page", title: "Page", type: "text", origin: "browser" },
    chunks: [{ chunk_index: 0, text_content: "A page with an illustration." }] });
  const graph = new SourceGraph(db, sdk.graph, "page", "browser");
  const page = graph.entity("https://example.com/page", "Page", "WebPage");
  const image = (key: string, type = "Image") => graph.entity(`https://example.com/${key}.png`, key, type);
  return { db, sdk, graph, page, image };
}

describe("retired connector images on the graph map", () => {
  it("hides only images with inactive history, keeping manual and never-supported orphans", () => {
    const { sdk, graph, page, image } = fixture();
    const inactive: ClaimStatus[] = ["stale", "retracted", "superseded", "rejected"];
    const retired = inactive.flatMap(status => ["Image", "ImageReference"].map(type => {
      const id = image(`${type}-${status}`, type);
      graph.link(page, "FEATURES_IMAGE", id, { status });
      return id;
    }));
    const outgoing = image("outgoing");
    graph.claim(outgoing, "DESCRIPTION", { value: "An old description" }, { status: "stale" });
    const orphan = image("orphan");
    const manual = sdk.graph.entities.create({ name: "Manual illustration", type: "Image" });
    const manualHistorical = sdk.graph.entities.create({ name: "Manual reference", type: "ImageReference" });
    sdk.graph.claims.add({ subject: manualHistorical.id, predicate: "DESCRIPTION", value: "Archived", status: "stale" });
    const topic = graph.entity("historical-topic", "Historical topic", "Topic");
    graph.link(page, "ABOUT", topic, { status: "stale" });

    const snapshot = getGraphData(sdk);
    expect(snapshot.nodes.map(node => node.id).sort((a, b) => a - b))
      .toEqual([page, orphan, manual.id, manualHistorical.id, topic].sort((a, b) => a - b));
    expect(snapshot.stats.totalEntities).toBe(5);
    expect(snapshot.edges).toHaveLength(0);
    for (const id of [...retired, outgoing]) expect(sdk.graph.entities.get(id).id).toBe(id);
  });

  it("keeps all live support as either endpoint, regardless of edge or viewport filters", () => {
    const { sdk, graph, page, image } = fixture();
    const supported = (["accepted", "proposed", "disputed"] as const).flatMap(status => {
      const incoming = image(`${status}-incoming`), outgoing = image(`${status}-outgoing`);
      graph.link(page, "FEATURES_IMAGE", incoming, { status, context: "support", validFrom: 10, validTo: 20 });
      graph.link(outgoing, "ILLUSTRATES", page, { status, context: "support", validFrom: 10, validTo: 20 });
      graph.link(page, "OLD_IMAGE", incoming, { status: "stale" });
      graph.link(page, "OLD_IMAGE", outgoing, { status: "stale" });
      return [incoming, outgoing];
    });
    const literal = image("live-description");
    graph.claim(literal, "DESCRIPTION", { value: "A supported description" });
    graph.link(page, "OLD_IMAGE", literal, { status: "stale" });
    const negative = image("negative-claim");
    graph.link(page, "FEATURES_IMAGE", negative, { polarity: -1 });
    graph.link(page, "OLD_IMAGE", negative, { status: "stale" });
    const filters: ClaimFilter[] = [
      { predicate: "UNRELATED" }, { namespace: "obsidian" }, { context: "elsewhere" }, { at: 30 },
      { excludePredicates: ["FEATURES_IMAGE", "ILLUSTRATES"] }, { statuses: ["accepted"], predicate: "UNRELATED" },
    ];
    for (const filter of filters) {
      const snapshot = getGraphData(sdk, filter);
      expect(snapshot.edges).toHaveLength(0);
      expect(snapshot.nodes.map(node => node.id).sort((a, b) => a - b))
        .toEqual([page, ...supported, literal, negative].sort((a, b) => a - b));
    }
  });

  it("keeps images with their own live source, without treating referenced chunks as ownership", () => {
    const { db, sdk, graph, page, image } = fixture();
    const owned = image("owned");
    graph.claim(owned, "SOURCE_URI", { value: "https://example.com/owned.png" }, { status: "stale" });
    const attachment = image("attachment");
    graph.link(page, "FEATURES_IMAGE", attachment, { status: "stale", evidence: graph.evidence(0) });
    expect(db.query("SELECT 1 FROM chunk_entities WHERE entity_id=?").get(attachment)).not.toBeNull();
    expect(getGraphData(sdk).nodes.map(node => node.id)).toEqual([page, owned]);
    // Historical mappings to removed sources do not provide live ownership.
    db.query("INSERT INTO source_entities(source_id,entity_id) VALUES(?,?)").run("removed-image-source", attachment);
    expect(getGraphData(sdk).nodes.map(node => node.id)).toEqual([page, owned]);
  });

  it("retains historical claims and renders explicitly requested inactive statuses", () => {
    const { sdk, graph, page, image } = fixture();
    const retired = image("retired");
    const claimId = graph.link(page, "FEATURES_IMAGE", retired);
    sdk.graph.lifecycle.review(claimId, "retracted", "test", "Image removed from the page");
    expect(getGraphData(sdk).nodes.map(node => node.id)).toEqual([page]);
    expect(sdk.graph.claims.get(claimId).status).toBe("retracted");
    expect(sdk.graph.lifecycle.inspect(claimId).history).toHaveLength(2);
    for (const statuses of [["retracted"], ["accepted", "retracted"]] as ClaimStatus[][]) {
      const snapshot = getGraphData(sdk, { statuses });
      expect(snapshot.nodes.map(node => node.id)).toEqual([page, retired]);
      expect(snapshot.edges).toEqual([expect.objectContaining({ id: claimId, source: page, target: retired, status: "retracted" })]);
    }
  });

  it("keeps historical accepted endpoints when querying a past knowledge snapshot", () => {
    const { db, sdk, graph, page, image } = fixture();
    const retired = image("past");
    const claimId = graph.link(page, "FEATURES_IMAGE", retired);
    sdk.graph.lifecycle.review(claimId, "stale", "test", "Evidence superseded");
    // Fix timestamps so this snapshot does not depend on test execution speed.
    db.query("UPDATE graph_claims SET recorded_at=10 WHERE id=?").run(claimId);
    db.query("UPDATE graph_status_history SET changed_at=CASE status WHEN 'accepted' THEN 10 ELSE 20 END WHERE claim_id=?").run(claimId);
    expect(getGraphData(sdk).nodes.map(node => node.id)).toEqual([page]);
    const snapshot = getGraphData(sdk, { knownAt: 15 });
    expect(snapshot.nodes.map(node => node.id)).toEqual([page, retired]);
    expect(snapshot.edges).toEqual([expect.objectContaining({ id: claimId, status: "accepted" })]);
  });

  it("keeps canonical roots when a merged identity has independent live support", () => {
    const { sdk, graph, page, image } = fixture();
    const root = image("root"), alias = image("alias");
    graph.link(page, "FEATURES_IMAGE", root, { status: "stale" });
    const liveId = graph.link(page, "FEATURES_IMAGE", alias);
    sdk.graph.entities.merge(alias, root, "Same illustration");
    const snapshot = getGraphData(sdk);
    expect(snapshot.nodes.map(node => node.id)).toEqual([page, root]);
    expect(snapshot.edges).toEqual([expect.objectContaining({ id: liveId, target: root })]);
    expect(getGraphData(sdk, { predicate: "UNRELATED" }).nodes.map(node => node.id)).toEqual([page, root]);
  });

  it("checks support only through the supplied database's scoped views", () => {
    const { db, sdk, graph, page, image } = fixture();
    const retired = image("scoped");
    graph.link(page, "FEATURES_IMAGE", retired, { status: "stale" });
    graph.link(page, "FEATURES_IMAGE", retired);
    graph.claim(retired, "SOURCE_URI", { value: "https://example.com/scoped.png" });
    expect(getGraphData(sdk).nodes.map(node => node.id)).toEqual([page, retired]);
    // Restricted SDKs expose these unqualified TEMP views over the same tables.
    db.run("CREATE TEMP VIEW graph_claims AS SELECT * FROM main.graph_claims WHERE status='stale'");
    db.run("CREATE TEMP VIEW source_entities AS SELECT * FROM main.source_entities WHERE 0");
    expect(getGraphData(sdk).nodes.map(node => node.id)).toEqual([page]);
  });
});
