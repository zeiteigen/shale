import { expect, it } from "bun:test";
import { createGraphSimulation } from "../visualizer/src/graph-force";
import { DEFAULT_FORCES } from "../visualizer/src/graph-preferences";
import { graphAdjacency, graphLayout } from "../visualizer/src/graph-layout";
import { visibleGraph } from "../visualizer/src/graph-visibility";
import type { GraphData, GraphEdge, GraphNode } from "../visualizer/src/types";

function node(id: number, type = "Note", degree = 1): GraphNode {
  return {
    id, name: `Node ${id}`, type, namespace: "test", stableId: `node-${id}`,
    canonicalId: null, degree, chunksCount: 0, chunks: [],
  };
}

function edge(id: string, source: number, target: number): GraphEdge {
  return { id, source, target, relation: "LINKS", weight: 1, status: "accepted" };
}

function data(nodes: GraphNode[], edges: GraphEdge[]): GraphData {
  return { nodes, edges, truncated: false, stats: { totalEntities: nodes.length, totalEdges: edges.length, totalSources: 0, totalChunks: 0, totalClaims: edges.length } };
}

it("shares type visibility and focus depth, including a selected hidden type", () => {
  const graph = data([node(1), node(2), node(3), node(4), node(5, "Vault")], [
    edge("1-2", 1, 2), edge("2-3", 2, 3), edge("3-4", 3, 4), edge("4-5", 4, 5),
  ]);
  const adjacency = graphAdjacency(graph);
  const types = new Set(["Note"]);

  expect(visibleGraph(graph, adjacency, types, 1, true, 1).nodes.map(item => item.id)).toEqual([1, 2]);
  expect(visibleGraph(graph, adjacency, types, 1, true, 2).nodes.map(item => item.id)).toEqual([1, 2, 3]);
  expect(visibleGraph(graph, adjacency, types, 1, true, 3).nodes.map(item => item.id)).toEqual([1, 2, 3, 4]);
  expect(visibleGraph(graph, adjacency, types, 5, true, 1).nodes.map(item => item.id)).toEqual([4, 5]);
  expect(visibleGraph(graph, adjacency, types, 5, false, 1).nodes.map(item => item.id)).toEqual([1, 2, 3, 4]);
});

it("drops dangling endpoints and their edges from the visible result", () => {
  const graph = data([node(1), node(2)], [edge("valid", 1, 2), edge("dangling", 2, 99)]);
  const visible = visibleGraph(graph, graphAdjacency(graph), new Set(["Note"]), undefined, false, 1);

  expect(visible.nodes.map(item => item.id)).toEqual([1, 2]);
  expect(visible.edges.map(item => item.id)).toEqual(["valid"]);
});

it("keeps classic grid positions deterministic", () => {
  const graph = data([node(1), node(2), node(3), node(4)], [edge("1-2", 1, 2)]);
  const types = new Set(["Note"]);
  const first = graphLayout(graph, graphAdjacency(graph), types, undefined, false, 1);
  const second = graphLayout(graph, graphAdjacency(graph), types, undefined, false, 1);

  expect([...first.points].map(([id, point]) => [id, point.x, point.y])).toEqual([...second.points].map(([id, point]) => [id, point.x, point.y]));
  expect([...first.points.values()].map(({ x, y }) => [x, y])).toEqual([
    [58 + ((37) % 19) - 9, 54 + ((17) % 13)],
    [58 + 86 + ((74) % 19) - 9, 54 + ((34) % 13)],
    [58 + 172 + ((111) % 19) - 9, 54 + ((51) % 13)],
    [58 + 258 + ((148) % 19) - 9, 54 + ((68) % 13)],
  ]);
});

function settle(edges: Array<{ source: number; target: number }>) {
  const input = [
    { id: 1, radius: 8, x: -30, y: 5 }, { id: 2, radius: 8, x: 25, y: -5 },
    { id: 3, radius: 8, x: 350, y: 20 }, { id: 4, radius: 8, x: 410, y: -20 },
  ];
  const before = structuredClone(input);
  const { simulation } = createGraphSimulation(input, edges, DEFAULT_FORCES);
  simulation.tick(500);
  const positions = simulation.nodes().map(({ id, x, y, radius }) => ({ id, x: x!, y: y!, radius }));
  simulation.stop();
  return { positions, before, input };
}

it("settles deterministically, preserves caller inputs, and treats reversed duplicate links equivalently", () => {
  const links = [{ source: 1, target: 2 }, { source: 3, target: 4 }, { source: 2, target: 1 }];
  const first = settle(links);
  const second = settle([{ source: 4, target: 3 }, { source: 2, target: 1 }, { source: 1, target: 2 }]);

  expect(first.input).toEqual(first.before);
  expect(first.positions).toEqual(second.positions);
  expect(first.positions.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
});

it("separates disconnected clusters and leaves collision clearance after settling", () => {
  const { positions } = settle([{ source: 1, target: 2 }, { source: 3, target: 4 }]);
  const byId = new Map(positions.map(point => [point.id, point]));
  const center = (a: number, b: number) => {
    const first = byId.get(a)!, second = byId.get(b)!;
    return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
  };
  const left = center(1, 2), right = center(3, 4);
  expect(Math.hypot(left.x - right.x, left.y - right.y)).toBeGreaterThan(100);
  for (let a = 0; a < positions.length; a++) for (let b = a + 1; b < positions.length; b++) {
    const first = positions[a], second = positions[b];
    expect(Math.hypot(first.x - second.x, first.y - second.y)).toBeGreaterThanOrEqual(first.radius + second.radius + 9.5);
  }
});
