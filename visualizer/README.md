# Shale Visualizer

The visualizer is a React notebook for browsing Shale's sources, passages, and knowledge graph.

```sh
cd visualizer
bun install
bun run dev
```

Open `http://localhost:5173` for the Vite development UI. It proxies API requests to the Bun server at `http://localhost:3333`.

For a production-style local server, run `bun run build`, then `bun run server`. The legacy `bun scripts/serve-visualizer.ts` command remains a compatibility entrypoint for that server.
