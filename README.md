# Shale

A local knowledge workspace with SQLite storage, modular connectors, and a unified web interface for host controls, settings, and the knowledge graph.

```sh
bun run setup   # bun install (root + visualizer) and each extension's installer, e.g. Instagram's Python sidecar
bun run start
```

Open **http://localhost:7425**. Use Overview to run background jobs and follow output, Settings to configure the host and extensions, Accounts to connect services such as Discord, Instagram, and [email](extensions/email/README.md), and Knowledge to explore sources and review claims.

The daemon serves the interface and ingestion API together. Settings are read fresh from disk; port and database changes require a restart. Host settings and their schema live in `resources/settings.json` and `resources/settings.help.json`. The `resources/` directory is version-controlled and also holds the access policy, configuration examples, and migration report. The `data/` directory is entirely gitignored: the default database is `data/production.db`, with backups in `data/backups/`. API keys live in `data/.env`, loaded at startup without overriding existing environment variables; use `resources/.env.example` as a template. Terminal commands remain available for automation, with `--cli` enabling the legacy interactive console.

See [the web interface guide](visualizer/README.md) for development, compatibility, and verification, and [the SDK guide](sdk/README.md) for extension development.

See [the source memory guide](docs/source-memory.md) for summary/snippet storage, editing, refresh, and migration. The future dreaming process is tracked in [the roadmap](docs/roadmap.md).

## Connect Pi to Shale's MCP server

Agents can edit entities, connections, evidence, sources, and chunks through 32 additional tools. See [the knowledge editing guide](docs/knowledge-editing.md) for tool contracts, source removal and restoration, and atomic preview/apply workflows.

Pi 1.0.4 supports MCP directly. Start Shale with `bun run start` and keep it running, then register its Streamable HTTP endpoint:

```sh
pi mcp add shale --url http://127.0.0.1:7425/mcp \
  --description 'Shale local knowledge graph: search and manage entities, claims, events, and relationships'
pi mcp list
```

This saves the connection in `~/.pi/agent/mcp.json` (or `$PI_CODING_AGENT_DIR/mcp.json` if set), making it available across projects. No adapter package or sign-in is required. `pi mcp list` should report `shale` as connected and list its graph tools. Start a new Pi session to load the connection; the default exposure is `codemode`. Ask Pi to use Shale to search the knowledge graph, inspect entities and claims, or traverse relationships.

For a connection scoped to this checkout, run the same `pi mcp add` command with `--local`. It writes `.pi/mcp.json`; Pi loads it when the project is trusted (use `pi --approve` to trust project files for that run).

The host proxies `/mcp` on its web port, which defaults to `7425`; update the URL if you change `PORT`. Check `http://127.0.0.1:7425/mcp/health` if the connection fails. The host also exposes MCP directly on port `7427` by default, configurable through `SHALE_MCP_PORT` or `MCP_PORT` in root settings.

To run only the MCP server, use `bun run mcp` and register `http://127.0.0.1:7426/mcp` instead. The standalone server defaults to port `7426`; `bun run mcp --port 7426 --db /absolute/path/to/shale.db` selects an explicit port and database.

Remove the global connection with `pi mcp remove shale`, or the project-local connection with `pi mcp remove shale --local`.

## Connect Codex to Shale's MCP server

Keep Shale running and register the same Streamable HTTP endpoint with Codex:

```sh
codex mcp add shale --url http://127.0.0.1:7425/mcp
codex mcp get shale
```

This adds an enabled `shale` server to `~/.codex/config.toml`. Start a new Codex session to load it, then ask Codex to use Shale's knowledge graph tools. No sign-in is required. Use the alternate URLs described above if you change the host port or run the standalone MCP server.

Remove the connection with `codex mcp remove shale`. See [OpenAI's MCP setup instructions](https://developers.openai.com/learn/docs-mcp) for the CLI registration workflow.

## Limit what an agent can see

Every source, entity, and claim gets a sensitivity tier: `public`, `personal`, `private`, or `secret`. Tiers are assigned automatically; heuristics run immediately and the `access-classifier` extension refines them with the chat model. Access profiles in `resources/access.json` set each agent's clearance. Unauthenticated requests use the `local` profile, which sees everything, so existing connections keep working.

To give a hosted agent less, open **Access** in the web interface and create a token for the `cloud` profile (personal clearance, so no private messages or credentials). Configure the agent's MCP connection to send it as an `Authorization: Bearer <token>` header. Each session is bound to the profile of the token that opened it.

Before exposing Shale through a tunnel, set **Requests without a token** to a restricted profile or to *Reject*. `bun run mcp --profile cloud` runs a listener that serves only one profile, without tokens. See [docs/access-control.md](docs/access-control.md) for how tiers and profiles work.
