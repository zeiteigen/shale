# Connectors and extension development

Manifests are the live contract; settings can disable work without removing a registered cron. The catalog below reflects the checked-in manifests on 2026-10-13. Folder names and manifest IDs are usually equal; the Obsidian folder currently declares the ID `obsidian parser` and namespace `obsidian`.

## Extension catalog

| Extension | Role and input | Important behavior |
| --- | --- | --- |
| [Obsidian](../extensions/obsidian/README.md) | Vault notes, frontmatter, wikilinks, images, document attachments | File/vault identities use paths, ambiguous links stay reference nodes, expansion is proposed knowledge. |
| [Directories](../extensions/directories/README.md) | Recursively selected local folders | Shared document/image processors, per-file fingerprints; default selection is empty. Removing a file/selection does not automatically erase knowledge. |
| [Browser](../extensions/browser/README.md) | Chrome pages, activity, history, bookmarks and sessions | Durable browser jobs, canonical page sources, retained observations and separate session narratives. |
| [AI chats](../extensions/ai-chats/README.md) | Signed-in ChatGPT/Claude/Gemini Chrome tabs | Active conversation branches; ChatGPT/Claude JSON readers and resumable sync, Gemini page capture. Separate provider origins/stores. |
| [Search queries](../extensions/search-queries/README.md) | Google/Bing/DuckDuckGo results pages | Query sources, AI Overview/result snippets and opened-result attribution; settled indexing. |
| [YouTube](../extensions/youtube/README.md) | Standard desktop watch pages | Actual playback creates a source; 50% unique played duration qualifies captions. Full-transcript overview and selected derived section summaries. |
| [Discord](../extensions/discord/README.md) | DiscordChatExporter JSON and connected-account REST sync | Bounded discovery/polling/backfill, user interests/participation and relevance admission; rolling raw archive with explicit incomplete coverage. |
| [Instagram](../extensions/instagram/README.md) | Official JSON export and optional instagrapi sidecar | Export encoding repair and deduplication across export/live feeds; shared chat windows. |
| [Email](../extensions/email/README.md) | Recursive EML/MBOX imports and read-only TLS IMAP | Shared chat windows, message deduplication, account/folder UIDVALIDITY cursors, newest-first collection and durable gaps. |
| [Process document](../extensions/process-document/README.md) | Shared document/text parsing requests | Format/size limits and optional synthesis; scanned PDFs need OCR elsewhere. |
| [Process image](../extensions/process-image/README.md) | Shared multimodal file processing | Visual layout/OCR and conceptual synthesis through the configured vision model. |
| [Web page parser](../extensions/web-page-parser/README.md) | Shared page extraction/enrichment requests | Readability/semantic extraction; public fetching is an explicit configurable capability. |
| [Knowledge extractor](../extensions/knowledge-extractor/README.md) | Retained source revisions | Grounded proposed assertions/events, typed entities, registry matching, source digest and user activity. |
| [Knowledge graph](../extensions/knowledge-graph/README.md) | Graph message handlers and identity resolver | Connector keys, canonical user accounts, registry and identity adjudication. |
| [Episodes](../extensions/episodes/README.md) | Source digests and canonical entity signals | Assignment, context reconsideration, nightly narrative consolidation and reviewed merges. |
| [Access classifier](../extensions/access-classifier/README.md) | Sources, entities, claims and retained history | Immediate heuristics plus periodic model sensitivity refinement. |
| [Source linker](../extensions/source-linker/README.md) | Legacy source-pair BM25 work | Disabled by default, including recovery; superseded by registry identity resolution and episodes. |
| [DB backup](../extensions/db-backup/README.md) | Local database snapshots | Hot SQLite backups with age/count retention; setup/import may also trigger startup backup behavior. |

## Cron catalog

Schedules below are manifest expressions. Model/collection limits and enablement settings still apply.

| Job | Schedule | Startup |
| --- | --- | --- |
| `access-classifier-cron` | `*/30 * * * *` | yes |
| `ai-chats-index` | `*/5 * * * *` | yes |
| `browser-session-aggregator` | `* * * * *` | yes |
| `db-backup-cron` | `0 2 * * *` | no |
| `directories-parser-cron` | `0 */6 * * *` | yes |
| `discord-import` | `*/15 * * * *` | yes |
| `discord-reclassify` | `*/5 * * * *` | no |
| `discord-sync` | `7 * * * *` | yes |
| `email-import` | `*/15 * * * *` | yes |
| `email-sync` | `0 * * * *` | no |
| `episodes-assign` | `*/10 * * * *` | yes |
| `episodes-consolidate` | `30 3 * * *` | no |
| `instagram-import` | `*/30 * * * *` | yes |
| `instagram-sync` | `17 */2 * * *` | no |
| `knowledge-extractor-cron` | `*/10 * * * *` | no |
| `identity-resolver` | `*/15 * * * *` | yes |
| `obsidian-parser-cron` | `0 0 * * *` | no |
| `search-queries-index` | `*/2 * * * *` | yes |
| `source-linker-cron` | `0 */4 * * *` | no |
| `youtube-index` | `*/2 * * * *` | yes |

## Manifest and execution contract

Create `extensions/<name>/` with `manifest.json`, `settings.json`, `settings.help.json`, `settings.types.ts`, focused implementation files and a README. Settings schemas define types, descriptions, defaults, ranges and optional possible values; user edits are validated and reads are fresh.

```json
{
  "name": "example",
  "namespace": "example",
  "version": "0.1.0",
  "description": "Collect example records",
  "checkpoint_recover": "recover.ts",
  "setup_script": "setup.ts",
  "crons": [
    { "name": "example-sync", "schedule": "*/15 * * * *", "script": "index.ts", "run_on_startup": true }
  ]
}
```

```ts
import type { ShaleSDK } from "@shale/sdk";

export async function run(sdk: ShaleSDK) {
  if (sdk.settings.get<boolean>("enabled") === false) return;
  // Collect and prepare outside a transaction; commit durable output and progress together.
}
```

[`lib/extension.ts`](../lib/extension.ts) defines optional hooks:

- `setup_script`: host initialization, commonly refresh-handler registration. Exports `setup`, default, or `init`.
- `subscribe_messages`: typed message-handler registration. Exports `registerMessages`, `setup`, default, or `init`.
- `subscribe_ingest`: exports `subscribe`; durable connectors additionally export `accept`, `inspect`, and `capabilities`.
- `checkpoint_recover`: receives the SDK and checkpoint context; commits/reconciles saved preparations before new cron work.
- `auth_script`: exports `auth` or a default [`AuthProvider`](../sdk/auth.ts). The Accounts UI uses its declared fields/methods/steps generically.
- `install_script`: idempotent one-time dependencies, run by `bun run setup`, such as a Python virtualenv under `data/<extension>/`.
- `chrome_module`: background, optional popup, and named injected entries bundled by the browser build script.

Credentials go through `sdk.credentials`, backed by the protected runtime credential file; browser responses expose status/account labels, never secrets. Service-specific auth behavior stays in the extension.

## Shared chat and Chrome behavior

[`sdk/chat/`](../sdk/chat/) stores conversations/messages separately from searchable knowledge. It cuts settled windows, tracks exact message membership and metadata hashes, prepares summaries, checkpoints, commits source/graph/window state, and publishes notifications after commit. Refresh reports incomplete raw history rather than synthesizing from a partial transcript. `ChatWindowPolicy` supports relevance, deferral, exclusion, reconciliation, protected agent edits and archive restoration. Use it for connector-specific admission instead of duplicating the commit machinery.

The Chrome core owns listeners, IndexedDB delivery/outbox, resumable jobs, receipts and the popup shell. A background entry default-exports `register(runtime)` with its manifest ID, protocol validator, URL claims, listeners, actions, jobs, status and defaults. Its scoped runtime supplies storage, enqueue/delivery, policy, jobs, injection and tab execution. A module imports no Chrome-core implementation. Specific URL claims prevent generic browser capture from competing with another connector.

A popup exports `render(container, popup)`; an inject entry default-exports a function. [`module-host.js`](../scripts/browser-chrome-extension/core/module-host.js) mediates execution worlds; keep DOM tracking versus page API access explicit. Rebuild after changes with `bun run browser:build`, commit generated files, then run `browser:check`. Reload the installed unpacked extension to use a new build. [Chrome runtime documentation](../scripts/browser-chrome-extension/README.md) describes installation and protocol details.

## Extension correctness checklist

Choose stable IDs and original-content fingerprints; bound input, retention and model work; define durable admission versus completed indexing; keep failed work retryable; acquire workflow leases before model reservations; commit output and progress atomically; retain evidence and uncertainty; define refresh/unavailability; preserve independent/manual support during cleanup; and test existing-schema migration, recovery, duplicate input and restricted consumers where applicable.
