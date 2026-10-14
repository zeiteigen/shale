# Agent Guidelines & System Architecture

This document outlines the core conventions, architecture patterns, and best practices for developing and maintaining the Shale codebase.

For repository onboarding and detailed current context, start with [docs/README.md](docs/README.md). It links the architecture, code map, data model, knowledge pipeline, connector catalog, and development workflow. Historical plans and dated runtime reports are not current operational state.

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
│   ├── graph/               # Graph schema; ontology.ts, identity-keys.ts, story-schema.ts (registry, digests, episodes)
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
│   ├── search-queries/      # Google, Bing, and DuckDuckGo searches, with opened results and AI Overviews, via its Chrome module
│   ├── youtube/             # Watched video metadata and transcript summaries after 50% unique playback
│   ├── process-image/       # Multimodal visual extraction (layout, OCR, synthetic meaning chunks)
│   ├── source-linker/       # Cross-source entity discovery and knowledge graph linker
│   ├── discord/             # Discord ingestion via DiscordChatExporter JSON (import folder + optional sync)
│   ├── instagram/           # Instagram DM ingestion via official data export (+ optional instagrapi sidecar)
│   ├── access-classifier/   # Heuristic + LLM sensitivity tiers for sources, entities, claims
│   ├── source-filter/       # Deterministic source-noise triage; LLM reviews uncertain cases
│   ├── knowledge-extractor/ # Per-source digest: summary, user activity, grounded claims, registry-resolved entities
│   ├── knowledge-graph/     # Graph message handlers + identity-resolver cron (keys, self, adjudication)
│   ├── episodes/            # Cross-source episodes: assignment, review, nightly consolidation
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
  - optional `claims`: `hosts` and/or a `match(url)` predicate (the browser module skips claimed URLs);
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
The host serves the web interface by default. Add `--cli` to enable the legacy interactive console over `process.stdin`:
```bash
# Run Shale host daemon (loads extensions, serves web UI and HTTP /ingest on :7425)
bun run main/index.ts

# Optional flags:
bun run main/index.ts --run-all-cron   # Run all crons once, then exit
bun run main/index.ts --cli            # Enable the interactive CLI
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
# Compatibility launcher for the unified host/web interface
bun run scripts/serve-visualizer.ts
```

---

## 7. Extension Reference Catalog

- **`extensions/obsidian`**: Deep integration with Obsidian vaults. Automatically parses frontmatter, wikilinks (`[[Page]]`), chunks notes by headings, expands short atomic notes via Chat LLM, batch-delegates image descriptions to `process-image`, and commits graph nodes.
- **`extensions/browser`**: Syncs Chrome browser tabs and visits. Aggregates tabs into browsing sessions, generates synthetic narrative summaries, and stores web history/bookmarks as verbatim chunks.
- **`extensions/process-image`**: Multimodal image processing service. Deconstructs diagrams, charts, and photos into verbatim visual layout and synthetic conceptual meaning chunks. Handles `file:process`, `files:process`, and `files:can-process`.
- **`extensions/source-linker`**: BM25 source-pair linker. Disabled by default (`enabled: false`), superseded by identity resolution and episodes.
- **`extensions/discord`**: Imports DiscordChatExporter JSON and performs bounded relevance-driven REST sync with the connected account. Time/request/message budgets, recent sampling, incremental cursors, and limited backfill mean coverage can be incomplete. Only admitted settled windows become searchable memories; the rolling raw archive remains private. Explicit participation, interests, and inclusion/exclusion rules guide admission. See the extension README for reconciliation and reclassification.
- **`extensions/instagram`**: Ingests Instagram DMs from the official "Download your information" JSON export (`data/instagram/import`), repairing the export's mojibake. An optional `instagram-sync` cron runs a Python instagrapi sidecar (`sidecar/ig_sync.py`), signed in from the Accounts page (password with 2FA/challenge codes, or a session cookie), that merges into the same threads without duplicates. Uses the same windowing as Discord.
- **`extensions/ai-chats`**: Ingests ChatGPT, Claude, and Gemini conversations through its Chrome module, which reads them from tabs where the user is signed in.
  - **ChatGPT and Claude:** read through the sites' own JSON endpoints. A conversation is captured when opened and re-checked while visible. A resumable `sync` job lists conversations and fetches the ones that changed.
  - **Gemini:** read from the open page.
  - **Snapshots:** the active branch only. An edit or regeneration prunes the abandoned branch.
  - **Indexing:** each provider (origin `chatgpt`, `claude`, or `gemini`) has its own `sdk/chat` store. The `ai-chats-index` cron cuts conversation windows into summarised `chat_session` sources.
- **`extensions/search-queries`**: Turns searches on Google, Bing, and DuckDuckGo into sources, through its Chrome module, which claims only results pages.
  - **Sources:** one per engine and normalised query (`web_search`, origin `search`). A repeated search updates it.
  - **Snippets:** Google's AI Overview, then each result opened from the search (same tab or a new tab from the results page; not links followed further).
  - **Indexing:** admission writes a raw log; the `search-queries-index` cron writes a search's source once it has been quiet for `settleMinutes`.
- **`extensions/access-classifier`**: Assigns sensitivity tiers to sources, entities, and claims. Heuristics catch credentials, account numbers, PII, sensitive topics, and direct messages; an LLM pass refines them. Access profiles use the tiers.
- **`extensions/source-filter`**: Sweeps automatic captures for clear noise every 30 minutes. Deterministic rules keep ordinary content and archive complete capture failures; only suspicious content reaches the LLM. Confirmed spam is archived and blocked, temporary capture failures allow recapture, and curated/restored sources are protected. Decisions are cached privately and removals use the audited knowledge API. Standalone `--dry-run` logs proposed removals without changing live sources.
- **`extensions/youtube`**: Captures standard watched YouTube videos through its Chrome module. One `youtube_video` source per video contains metadata and description; after unique played portions cover 50% of its duration, its summary becomes a whole-transcript LLM overview and its snippets contain detailed LLM-chosen section summaries with timestamps. Played ranges persist across visits and restarts. Raw captures and intermediate summaries remain extension-private; `youtube-index` runs every two minutes.
- **`extensions/knowledge-extractor`**: Digests every source revision, newest first, every ten minutes. The digest holds a summary, the user's involvement and activity, grounded claims and events, and typed entities with descriptions, search keys, and identifying URLs. The prompt carries metadata and a shortlist of known registry entities and open episodes, so the model links mentions by id. Every entity goes through the identity resolver. Digests land in `graph_source_digests`.
- **`extensions/knowledge-graph`**: Graph message handlers plus the `identity-resolver` cron. The cron keys connector entities (accounts, guilds, URLs), merges on strong keys, links pages to what they show and servers to their organizations, gathers the user's accounts into the `self` Person, and adjudicates name collisions with the model. Merges are audited and reversible. See `sdk/graph/identity.ts`.
- **`extensions/episodes`**: Assigns digested sources to cross-source episodes. Scoring uses the IDF of shared canonical entities, recency, and the digest's own pick; the model reviews the middle band. A nightly pass rewrites titles, summaries, and steps and merges split stories. Episodes are read with `list_episodes`, `get_episode`, and `entity_timeline`, and on the web interface's Episodes page.
- **`extensions/db-backup`**: Hot backup utility. Uses SQLite backup APIs to create consistent database snapshots without stopping host operations.

---

## 8. Access Profiles & Permissions

Users decide which data each consumer may use (`docs/access-control.md`).
- **Tiers and profiles.** Records have a tier (`public < personal < private < secret`), set automatically by heuristics and `access-classifier`, or manually. Profiles in `resources/access.json` (read fresh, created with defaults on first use) set a clearance plus `allow`/`deny` source patterns and `write`.
- **Enforcement lives in the database layer.** `lib/access/scoped-database.ts` gives each restricted profile a read-only connection whose TEMP views shadow every `main` table. Unknown tables are shadowed by empty views. Readers need no permission code of their own; just use the scoped SDK.
- **New tables.** Add a row filter to `shadowFilters` if a scoped consumer should see the table's rows; otherwise it stays hidden. New `chunks_fts` queries must join `chunks`. New `entity_registry_fts` queries must join `entities` (or `graph_episodes`).
- **Episodes.** An `Episode` entity is visible only when every active member and retained narrative input source is visible across its identity group (`lib/access/visibility.ts`). Durable `graph_episode_provenance` survives detachment and source removal until a complete narrative rewrite replaces its inputs.
- **New write paths.** Add every write tool or knowledge operation to `WRITE_REFERENCES` in `lib/access/write-guard.ts`, listing the record ids it references. Unlisted writes are refused for restricted profiles. Audited writes must go through `sdk.knowledge` (`record`/`apply`) so the guard runs inside the transaction.
- **MCP.** Clients authenticate with `Authorization: Bearer <token>`; tokens are created on the web interface's Access page. Requests without a token use `unauthenticatedProfile`.
