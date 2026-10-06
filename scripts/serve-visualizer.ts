// Compatibility entrypoint for the unified local Shale interface.
export { getGraphData, startVisualizerServer, type GraphData } from "../visualizer/server";
import { runWebHost } from "./start-web-host";

if (import.meta.main) await runWebHost();
