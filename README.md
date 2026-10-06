# Shale

A local knowledge workspace with SQLite storage, modular connectors, and a unified web interface for host controls, settings, and the knowledge graph.

```sh
bun install
bun install --cwd visualizer
bun run start
```

Open **http://localhost:7425**. Use Overview to run background jobs and follow output, Settings to configure the host and extensions, and Knowledge to explore sources and review claims.

The daemon serves the interface and ingestion API together. Settings are read fresh from disk; port and database changes require a restart. API keys remain in `.env`. Terminal commands remain available for automation, with `--cli` enabling the legacy interactive console.

See [the web interface guide](visualizer/README.md) for development, compatibility, and verification, and [the SDK guide](sdk/README.md) for extension development.
