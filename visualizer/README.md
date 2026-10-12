# Shale local web interface

The React application combines host controls, settings, and the knowledge notebook. Everything is served by the Shale daemon on one loopback address.

From the project root:

```sh
bun install
bun install --cwd visualizer
bun run start
```

Open **http://localhost:7425**. `bun run start` builds the interface before starting the daemon. The root `PORT` setting changes this address after a restart. Once built, `bun run main/index.ts` starts the same interface directly.

- **Overview** shows host uptime, memory, loaded extensions, scheduled jobs, recent run results, a command console, and live host output. Individual jobs and Run all execute in the background; Run all runs jobs sequentially. Recent manual results and output remain available when the browser is reloaded, for the lifetime of the daemon.
- **Settings** lists the host and every extension. Controls follow each `settings.help.json` schema, with descriptions, defaults, allowed values, and number ranges. Arrays and objects use JSON editors. Save writes atomically to `settings.json`; Reset restores a field or all documented defaults. Reload reads changes made outside the browser. `SHALE_SETTINGS_PATH` is respected for host settings. API keys remain in `data/.env`. Port and database settings require restarting the daemon.
- **Knowledge** opens each entry in a summary-first reader. Separate tabs show expandable, searchable snippets; grouped incoming/outgoing connections; paginated claims and their evidence; and source details and identity corrections. Snippets distinguish quoted excerpts from derived notes. Metadata and old claim statuses remain available through filters. Retained memory loads on demand for the selected source, and the reader works on mobile. Selecting an entry fades unrelated nodes; **Focus on map** isolates its neighborhood. Dashed lines represent proposed or disputed assertions; retained revisions remain readable after their source changes.

Summaries, expanded snippets, and evidence quotes render Markdown and mathematical notation. The formatter loads when retained text is opened. Equations, code blocks, and tables stay within the reader on small screens. Source images are explicit links, so reading a snippet does not fetch external images.

The Knowledge map defaults to **Organic**, a force graph with connected clusters and collision spacing. Drag empty space to pan, scroll to zoom, click an entry to read it, or drag a node and release it to let it settle. **Forces** adjusts center attraction, repulsion, link strength, and link distance; Restore defaults resets those controls. **Classic** restores the original rectangular map. The view and force settings are remembered in this browser; switching views keeps the current reader and filters and restores each view's camera. Reduced-motion preferences show the settled layout without progressive animation.

The daemon starts without terminal input by default. `--cli` opts into the legacy terminal console; `--no-cli` remains accepted. Existing settings commands are retained for scripts. Stop host in the web header confirms shutdown, including interruption of running jobs.

`bun run visualizer` and `bun scripts/serve-visualizer.ts` also launch the unified daemon. They do not start a separate visualizer service. The exported `startVisualizerServer` function remains available for legacy graph API consumers; use the daemon for the complete interface.

The interface binds to `127.0.0.1` and rejects external origins and hostnames. The existing `/health`, `/connectors`, and `/ingest` contracts are preserved for browser ingestion.

## Development

```sh
cd visualizer
bun run dev
```

This starts the daemon and Vite together. Open **http://localhost:5173** for the development interface. Vite proxies `/api` to the daemon's configured host port. Only matching local origins are translated for the proxy. The interface uses the single host `PORT` setting.

## Verification

```sh
bun run typecheck
bun run test:web
bun run test:web:browser
```

The browser test builds the interface and uses an installed Chromium (`/usr/bin/chromium` by default, or `SHALE_CHROMIUM_PATH`). Tests use temporary settings and a separate database, and do not run the production extensions' background jobs.
