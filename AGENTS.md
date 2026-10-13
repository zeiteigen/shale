# Agent Guidelines & System Architecture

This document outlines the core conventions, architecture patterns, and best practices for developing and maintaining the Shale codebase.

---

## 1. Core Principles

1. **Local-First & Resource Conscious**: Shale operates on local SQLite databases and local LLM endpoints (or remote fallback endpoints). Extensions must be performant, non-blocking, and cleanly isolate long-running workloads.
2. **Resilient Hot-Reloading & State Isolation**:
   - Settings are read dynamically on the fly from disk without sticky in-memory caches.
   - Extensions use persistent watermarks and transactional checkpoints to guarantee recovery upon crashes or interruptions.
3. **Cross-Extension Decoupling**: Extensions communicate via a unified, typed cross-extension message bus (`lib/messages.ts`, `sdk/messages.ts`), avoiding direct import coupling.
4. **Permission-Scoped Consumers**: Anything that serves graph data to an agent or another application goes through an access profile (`createScopedSDK` in `sdk/access.ts`), never the raw connection. See Section 8.

---

## 2. Directory Structure

```
shale/
├── resources/               # Version-controlled host configuration, examples, and reports
├── data/                    # Entirely gitignored local databases, credentials, backups, and connector files
├── lib/                     # Low-level core infrastructure (database, message bus, models)
│   ├── db.ts                # SQLite database setup, schema migrations
│   ├── messages.ts          # Core pub/sub and request/response message broker
│   ├── ai.ts                # LLM API clients
│   ├── access/              # Sensitivity tiers, access profiles, scoped connections, write guard
│   └── extension.ts         # Extension interfaces and cron definitions
├── sdk/                     # High-level developer SDK (@shale/sdk)
│   ├── index.ts             # SDK entry point, ambient scope, factory
│   ├── settings.ts          # SettingsManager (reads settings.json fresh on every call)
│   ├── state.ts             # StateManager for extension watermarks and kv-state
│   ├── ingest.ts            # Document chunking, hashing, and database ingestion
│   ├── search.ts            # Full-text search engine (BM25 + keyword rank fusion)
│   ├── messages.ts          # Type-safe messaging interface for extensions
│   ├── llm.ts               # LLM querying interface with thinking tokens & multimodal support
│   ├── checkpoint.ts        # Recovery checkpoint manager for multi-phase tasks
│   ├── access.ts            # createScopedSDK: profile-filtered read SDK + guarded write SDK
│   └── chat/                # Shared chat-connector toolkit: message store, time windows, transcripts, summaries, graph commit
├── extensions/              # Autonomous modular extensions
│   ├── obsidian/            # Obsidian vault ingestion, frontmatter/wikilink parsing, note chunking
│   ├── browser/             # Chrome browser tab sync, session clustering, history/bookmarks ingestion (Chrome module in chrome/)
│   ├── ai-chats/            # ChatGPT, Claude, and Gemini conversations captured by its Chrome module
│   ├── process-image/       # Multimodal visual extraction (layout, OCR, synthetic meaning chunks)
│   ├── source-linker/       # Cross-source entity discovery and knowledge graph linker
│   ├── discord/             # Discord ingestion via DiscordChatExporter JSON (import folder + optional sync)
│   ├── instagram/           # Instagram DM ingestion via official data export (+ optional instagrapi sidecar)
│   ├── access-classifier/   # Heuristic + LLM sensitivity tiers for sources, entities, claims
│   └── db-backup/           # Automated background SQLite database hot backups
├── main/                    # Host daemon and orchestration
│   ├── index.ts             # Main process entry, Bun.serve HTTP server, startup runner
│   ├── cli.ts               # Interactive CLI, manual cron triggers, settings commands, ghost suggestions & tab autocompletion
│   └── load-extensions.ts   # Auto-discovery of manifests, crons, hooks, and message handlers
├── scripts/                 # Developer tools, CLIs, browser extensions
│   ├── settings.ts          # Settings CLI and Clack TUI runner
│   ├── build-browser-modules.ts # Bundles every extension's chrome_module into the Chrome extension
│   └── browser-chrome-extension/ # Chrome extension core (outbox, delivery, jobs, popup shell) + generated modules/
└── tests/                   # Automated Bun test suites
```

---

## 3. Extension Development Standards

Every extension lives in `extensions/<extension-name>` and adheres to the following layout:

```
extensions/<name>/
├── manifest.json            # Extension metadata, crons, capabilities, hooks
├── settings.json            # Active user settings (read on the fly)
├── settings.help.json       # Settings schema, validation rules, descriptions, defaults
├── settings.types.ts        # TypeScript types representing settings.json
├── index.ts                 # Main extension entry (registers message handlers, startup logic)
├── recover.ts               # (Optional) Checkpoint recovery script
└── README.md                # Extension documentation
```

### Manifest Specifications (`manifest.json`)

```json
{
  "name": "extension-name",
  "description": "Human-readable description of extension capabilities",
  "version": "1.0.0",
  "crons": [
    {
      "name": "cron-job-name",
      "schedule": "0 */6 * * *",
      "script": "index.ts",
      "run_on_startup": true
    }
  ],
  "checkpoint_recover": "recover.ts",
  "auth_script": "auth.ts",
  "install_script": "install.ts",
  "setup_script": "refresh.ts",
  "subscribe_ingest": "subscribe.ts",
  "chrome_module": {
    "background": "chrome/background.ts",
    "popup": "chrome/popup.ts",
    "inject": { "page-reader": "chrome/inject/page-reader.ts" }
  }
}
```

`subscribe_ingest` receives `POST /ingest` envelopes whose `target_processor` is the extension's name. Export `accept` for durable admission with receipts, `inspect` for `/connectors/<name>/*`, and `capabilities` for `/health`.

### Chrome Extension Modules (`chrome_module`)

The Chrome extension in `scripts/browser-chrome-extension` is a core runtime shared by all extensions. It owns Chrome's listeners, the IndexedDB outbox, delivery and receipts, resumable jobs, and the popup shell. Extensions contribute their own code as modules; never add extension-specific code to the core.
- **Background entry.** Default-export `register(runtime)` and return a definition:
  - `id` must equal the manifest `name`, which is also the delivery processor;
  - `protocol: { batchType, version, validate }`;
  - optional `claims.hosts` (the browser module skips those hosts);
  - `listeners` (`navigation`, `tabComplete`, `alarm`, …);
  - `actions`, called from the popup as `<id>:<action>`;
  - `jobs: { kind: { step, summary } }`;
  - `wake`, `status`, and `defaults`.
- **Runtime.** It is scoped to the module: `enqueue`, `hasRecord`, `deliver`, `storage`, `policy` (the cached `/connectors/<id>/policy`), `createJob`, `resume`, `inject`, `execInTab`, and `claimedByOther`. Modules import nothing from the core.
- **Popup and inject entries.** A popup entry exports `render(container, popup)`. Inject entries default-export a function that `runtime.inject(tabId, name, { args })` runs in the page.
- **Build.** `bun run browser:build` bundles the modules into `scripts/browser-chrome-extension/modules/` and generates static registries. Commit the output. `bun run browser:check`, run by the test suite, fails when the output is stale.

### One-time Setup (`install_script`)

`bun run setup` installs Bun dependencies (root and `visualizer/`), then runs every extension's `install_script`. This covers dependencies Bun can't provide, such as a Python virtualenv under `data/<extension>/`. `bun run setup <extension>…` runs only those installers. Installers must be idempotent and should leave the extension working without manual settings changes.

### Accounts & Credentials (`auth_script`)

Extensions that need a login declare `auth_script` in their manifest. The module exports an `AuthProvider` (`sdk/auth.ts`) as `auth` or as its default export. The provider supplies a title, an optional ToS/risk `warning`, sign-in `methods` with their fields, `status`, `connect`, an optional multi-step `submit` (2FA codes and so on), optional `verify`, and `disconnect`.
- **Generic host and UI.** The host lists providers at `GET /api/auth` and routes `POST /api/auth/<extension>/{connect,submit,verify,disconnect}`. The web interface's **Accounts** page renders whatever providers declare. Never add service-specific code to the host or the React app.
- **Where secrets live.** Use `sdk.credentials` (`get`, `set`, `resolve(key, envFallback)`, `clear`). It is backed by `data/credentials.json` (mode 0600, read fresh on every call; override the path with `SHALE_CREDENTIALS_PATH`). Secrets are write-only from the browser: providers return only status and account labels.

---

## 4. Configuration & Settings Hot-Reloading

- **On-The-Fly Reading**: `SettingsManager` in `sdk/settings.ts` reads `settings.json` freshly from disk on every invocation of `.get()` or `.getAll()`. There is no persistent in-memory cache.
- **Dynamic CLI Updates**: Changes made through `settings set` (or the interactive daemon CLI) write directly to `settings.json` and are immediately visible to all running extension routines without restarting the host process.
- **Validation Schema**: Always pair settings with `settings.help.json` defining `type`, `description`, `default`, `range` (min/max), and optional `possibleValues`.

---

## 5. Cross-Extension Messaging

Extensions should never directly import files or internal classes from other extensions. Instead, use the message bus:

### Request / Response (Point-to-Point)
```typescript
// Sender
const result = await sdk.messages.request("file:process", {
  filePath: "/path/to/diagram.png",
});

// Receiver (in extension index.ts)
sdk.messages.handle("file:process", async (req) => {
  return await processFile(req.filePath, req.options);
}, {
  priority: 10,
  canHandle: (req) => isImageFile(req.filePath),
});
```

### Event Broadcasting (Pub / Sub)
```typescript
// Publisher
await sdk.messages.publish("source:ingested", {
  sourceId: "source-123",
  namespace: "obsidian",
});

// Subscriber
sdk.messages.on("source:ingested", async (event) => {
  console.log("Source ingested:", event.sourceId);
});
```

---

## 6. CLI & Operations

### Standalone Settings CLI
```bash
# List all extensions and their settings status
bun run settings list-extensions

# View settings for an extension
bun run settings list obsidian

# Describe a specific setting
bun run settings describe obsidian includeImages

# Update a setting
bun run settings set obsidian includeImages true
```

### First-time Setup
```bash
bun run setup               # bun install + every extension's install_script
bun run setup instagram     # just one extension (e.g. its Python sidecar)
```

### Launch Host & Interactive Daemon CLI
When starting the host daemon, an interactive CLI runs over `process.stdin`:
```bash
# Run Shale host daemon (loads extensions, starts HTTP /ingest on :7425, opens CLI)
bun run main/index.ts

# Optional flags:
bun run main/index.ts --run-all-cron   # Run all crons once on boot
bun run main/index.ts --no-cli         # Disable interactive CLI (headless/background mode)
```

#### Running Commands in the Daemon CLI:
- **Cron Commands**:
  - **`cron list`** (or `crons`): List all registered cron jobs with extension names, schedules, and scripts.
  - **`cron run <name>`** (or `run <name>`, `trigger <name>`): Manually trigger a specific registered cron job by name or extension ID.
  - **`cron run all`** (or `run all`): Trigger all registered cron jobs sequentially.
- **Extension Settings Commands**:
  - **`settings list-extensions`** (or `settings extensions`): List discovered extensions and settings file status.
  - **`settings list <extension>`** (or `settings ls <extension>`): Display all active settings for an extension.
  - **`settings get <extension> [key]`**: Retrieve a specific setting value or formatted JSON of all settings.
  - **`settings set <extension> <key> <value>`**: Update a setting with immediate validation against `settings.help.json` and hot-reload.
  - **`settings describe <extension> [key]`**: Display parameter specifications, types, defaults, ranges, and allowed options.
  - **`settings reset <extension> [key]`**: Reset a specific setting or all settings to defaults defined in `settings.help.json`.
  - **`settings tui [extension]`**: Launch interactive Clack Terminal User Interface (TUI).
  - **`settings`** (or `settings help`): Display extension settings command reference.
- **Host & System Commands**:
  - **`status`**: Inspect host daemon status, port, uptime, memory, and loaded extensions.
  - **`help`** (or `?`): Show list of available commands.
  - **`exit`** (or `quit`): Gracefully shut down the daemon.

#### Typing Suggestions & Tab Autocompletion:
- **Real-time Suggestions**: As you type into the interactive CLI prompt in a terminal, matching command suggestions appear automatically in muted gray ghost text (`shale> sett` → `ings`).
- **Tab Autocompletion**: Pressing `Tab` (or `Right Arrow` at the end of the line) instantly accepts and autocompletes the active suggestion into your command buffer.

### Launch Visualizer
```bash
# Launch knowledge graph visualizer web server
bun run scripts/serve-visualizer.ts
```

---

## 7. Extension Reference Catalog

- **`extensions/obsidian`**: Deep integration with Obsidian vaults. Automatically parses frontmatter, wikilinks (`[[Page]]`), chunks notes by headings, expands short atomic notes via Chat LLM, batch-delegates image descriptions to `process-image`, and commits graph nodes.
- **`extensions/browser`**: Syncs Chrome browser tabs and visits. Aggregates tabs into browsing sessions, generates synthetic narrative summaries, and stores web history/bookmarks as verbatim chunks.
- **`extensions/process-image`**: Multimodal image processing service. Deconstructs diagrams, charts, and photos into verbatim visual layout and synthetic conceptual meaning chunks. Handles `file:process`, `files:process`, and `files:can-process`.
- **`extensions/source-linker`**: Cross-source graph linker. Discovers unlinked entity references across disparate sources and generates semantic edges.
- **`extensions/discord`**: Ingests Discord channels, threads, and DMs from DiscordChatExporter JSON exports dropped into `data/discord/import`. The hourly `discord-sync` cron uses the account connected on the web interface's Accounts page (user or bot token) and the exporter installed by `bun run setup discord`. It sweeps every visible server and DM channel by channel, with per-channel watermarks; the first sync of a channel fetches its full history. Messages are split into conversation windows (one source each) with LLM summaries, and authors become `Person` entities with `external:discord` aliases.
- **`extensions/instagram`**: Ingests Instagram DMs from the official "Download your information" JSON export (`data/instagram/import`), repairing the export's mojibake. An optional `instagram-sync` cron runs a Python instagrapi sidecar (`sidecar/ig_sync.py`), signed in from the Accounts page (password with 2FA/challenge codes, or a session cookie), that merges into the same threads without duplicates. Uses the same windowing as Discord.
- **`extensions/ai-chats`**: Ingests ChatGPT, Claude, and Gemini conversations through its Chrome module, which reads them from tabs where the user is signed in.
  - **ChatGPT and Claude:** read through the sites' own JSON endpoints. A conversation is captured when opened and re-checked while visible. A resumable `sync` job lists conversations and fetches the ones that changed.
  - **Gemini:** read from the open page.
  - **Snapshots:** the active branch only. An edit or regeneration prunes the abandoned branch.
  - **Indexing:** each provider (origin `chatgpt`, `claude`, or `gemini`) has its own `sdk/chat` store. The `ai-chats-index` cron cuts conversation windows into summarised `chat_session` sources.
- **`extensions/access-classifier`**: Assigns sensitivity tiers to sources, entities, and claims. Heuristics catch credentials, account numbers, PII, sensitive topics, and direct messages; an LLM pass refines them. Access profiles use the tiers.
- **`extensions/db-backup`**: Hot backup utility. Uses SQLite backup APIs to create consistent database snapshots without stopping host operations.

---

## 8. Access Profiles & Permissions

Users decide which data each consumer may use (`docs/access-control.md`).
- **Tiers and profiles.** Records have a tier (`public < personal < private < secret`), set automatically by heuristics and `access-classifier`, or manually. Profiles in `resources/access.json` (read fresh, created with defaults on first use) set a clearance plus `allow`/`deny` source patterns and `write`.
- **Enforcement lives in the database layer.** `lib/access/scoped-database.ts` gives each restricted profile a read-only connection whose TEMP views shadow every `main` table. Unknown tables are shadowed by empty views. Readers need no permission code of their own; just use the scoped SDK.
- **New tables.** Add a row filter to `shadowFilters` if a scoped consumer should see the table's rows; otherwise it stays hidden. New `chunks_fts` queries must join `chunks`.
- **New write paths.** Add every write tool or knowledge operation to `WRITE_REFERENCES` in `lib/access/write-guard.ts`, listing the record ids it references. Unlisted writes are refused for restricted profiles. Audited writes must go through `sdk.knowledge` (`record`/`apply`) so the guard runs inside the transaction.
- **MCP.** Clients authenticate with `Authorization: Bearer <token>`; tokens are created on the web interface's Access page. Requests without a token use `unauthenticatedProfile`.
