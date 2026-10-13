# Discord

Shale can import DiscordChatExporter JSON files and can run a bounded, interest-driven sync using the Discord account connected in **Accounts**. The sync evaluates recent conversation windows for relevance and indexes accepted conversations; it is not a complete archive of every server or every public message.

## Account sync

The `discord-sync` job polls on its hourly schedule when a Discord account is connected. A run is bounded by `syncBudgetMinutes`, `syncMaxRequests`, and `syncMaxMessages`. It samples recent conversation activity and may backfill a limited number of older messages (`backfillMaxMessages`) when needed. These limits mean coverage can be incomplete between runs, and a bounded sample does not guarantee that every message from every interval is fetched.

The connected user token identifies your own user ID automatically. For a bot token or imports without a connected account, set `selfUserIds`. Configure `interests`, `excludedTopics`, and the include/exclude lists for people and conversations to guide selection. Shale also derives interests from permitted personal sources and your own Discord activity using `interestProfile`. Explicit exclusions take precedence over inclusions. Missing identity or unavailable model evidence leaves uncertain work pending.

Settled windows are evaluated up to `relevanceMaxWindows` per run, with at most `relevanceMaxLLMCalls` model calls. `relevanceThreshold` sets the minimum score for acceptance. Relevance checks can be disabled with `relevanceEnabled`; the sync and storage limits still apply.

Sync state reports messages or windows as **accepted**, **excluded**, **pending**, **backfilled**, or **evicted**. A conversation may also be marked as having **incomplete coverage** when its bounded polling or backfill has not covered the full interval. Reusable checkpoints let interrupted work resume, and failed work can be retried without treating a partial run as complete.

Raw connector messages are retained in local Discord connector SQLite tables, separate from full-text search indexing. Retention is bounded by age (`rawRetentionDays`), total size (`rawMaxMiB`), and per-conversation message count (`rawMaxConversationMessages`). Only settled windows selected as relevant are turned into searchable conversation sources; raw connector retention does not make all message history searchable.

## Manual JSON imports

Manual DiscordChatExporter JSON imports remain supported. Put JSON exports in `importDir` (default `data/discord/import/`) for the import job to process. For example:

```bash
DiscordChatExporter.Cli export -t "$DISCORD_TOKEN" -c <channel-id> -f Json -o data/discord/import/
```

`syncScope`, `channels`, `guilds`, `includeDMs`, and `includeThreads` still control which conversations account sync may collect. `dceCommand`, `initialSyncDays`, exporter timeouts, media-download options, and export-directory options remain available to the legacy exporter utility; bounded account sync does not use them or require an exporter installation.

## Conversation indexing

Messages are grouped into windows using `gapMinutes`, `maxWindowMessages`, and `maxWindowChars`. The newest window waits for `idleMinutes` of silence before it is considered settled. Accepted windows become searchable `chat_session` sources with transcript chunks and a summary. Edits can refresh the corresponding window, while backfilled messages can update windows they overlap.

Direct contacts and substantive contributors become `Person` entities. Incidental authors remain transcript text. Joining a thread, posting, replying, being mentioned, or reacting causes related context to be reconsidered; it does not admit every message in the parent channel or server. Durable context jobs can retrieve older thread starters and referenced messages beyond the rolling archive. Deleted or inaccessible history is reported as incomplete.

Existing Discord sources are reclassified in resumable batches. Rejected searchable sources and connector assertions are removed from current views, while unsupported identities remain available for historical inspection. Independently supported, merged, and manually maintained records are preserved. Raw windows awaiting a decision or checkpoint recovery are protected from eviction; archive admission pauses when they consume the available capacity. SQLite may retain allocated pages for reuse, so `rawMaxMiB` caps payload rather than the whole database file.

The `discord-reclassify` job processes stored history every five minutes without collecting more messages. To finish eligible cleanup immediately, run `bun extensions/discord/reclassify.ts --drain`. Each batch keeps the configured work limits. Missing identity, unavailable model evidence, and recent unsettled windows remain pending. After fixing a model outage or response-format issue, add `--retry-pending` to retry deferred classifier decisions once.
