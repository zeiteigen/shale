import { createGraphSimulation } from './graph-force';
import type { GraphWorkerRequest, GraphWorkerSnapshot } from './graph-worker-types';

let engine: ReturnType<typeof createGraphSimulation> | undefined;
let revision = 0, reducedMotion = false, paused = false, lastPost = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

function snapshot(settled: boolean) {
  const nodes = engine!.simulation.nodes(), positions = new Float64Array(nodes.length * 3);
  nodes.forEach((node, index) => { positions[index * 3] = node.id; positions[index * 3 + 1] = node.x!; positions[index * 3 + 2] = node.y!; });
  const message: GraphWorkerSnapshot = { revision, positions, settled };
  postMessage(message, { transfer: [positions.buffer] });
  lastPost = performance.now();
}

function step() {
  timer = undefined;
  if (!engine || paused) return;
  const simulation = engine.simulation, start = performance.now();
  let ticks = 0;
  do { simulation.tick(); ticks++; } while (simulation.alpha() >= simulation.alphaMin() && ticks < 4 && performance.now() - start < 8);
  const settled = simulation.alpha() < simulation.alphaMin();
  if (settled || !reducedMotion && performance.now() - lastPost >= 33) snapshot(settled);
  if (!settled) timer = setTimeout(step, 12);
}

function schedule() {
  if (!paused && timer === undefined) timer = setTimeout(step, 0);
}

onmessage = (event: MessageEvent<GraphWorkerRequest>) => {
  const message = event.data;
  if (message.kind === 'pause') {
    paused = message.paused;
    if (paused) { clearTimeout(timer); timer = undefined; } else if (engine && engine.simulation.alpha() >= engine.simulation.alphaMin()) schedule();
    return;
  }
  if (message.kind === 'init') {
    clearTimeout(timer); timer = undefined;
    engine?.simulation.stop();
    revision = message.revision; reducedMotion = message.reducedMotion;
    engine = createGraphSimulation(message.nodes, message.edges, message.forces);
    if (message.nodes.length <= 1) {
      const node = engine.simulation.nodes()[0];
      if (node) { node.x = message.nodes[0].x ?? 0; node.y = message.nodes[0].y ?? 0; }
      engine.simulation.alpha(0); snapshot(true);
    } else {
      if (!reducedMotion) snapshot(false);
      schedule();
    }
    return;
  }
  if (!engine || message.revision !== revision) return;
  if (message.kind === 'forces') engine.configure(message.forces);
  else {
    const node = engine.simulation.nodes().find(node => node.id === message.id);
    if (!node) return;
    node.x = message.x; node.y = message.y; node.vx = node.vy = 0;
    node.fx = message.release ? null : message.x; node.fy = message.release ? null : message.y;
    engine.simulation.alpha(.25).alphaTarget(message.release ? 0 : .1);
  }
  schedule();
};
