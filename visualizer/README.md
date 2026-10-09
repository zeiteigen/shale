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
- **Knowledge** retains the notebook's search, graph filters, source passages, claim/evidence inspection, reviews, renaming, and reversible identity merges. Dashed lines represent proposed or disputed assertions; saved revisions remain readable after their source changes.

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
