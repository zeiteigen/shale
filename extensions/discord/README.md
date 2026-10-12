# Discord

Ingests Discord server channels, threads, DMs, and group DMs. Discord has no official API for reading a personal account's messages, so this extension uses the community tool [DiscordChatExporter](https://github.com/Tyrrrz/DiscordChatExporter) (DCE) and its JSON export format.

## Feeds

**1. Import folder (always on).** The `discord-import` cron runs every 15 minutes and at startup. It ingests any DCE JSON file under `importDir` (default `data/discord/import/`). It skips files whose size and modification time haven't changed. Export files by hand with:

```bash
DiscordChatExporter.Cli export -t "$DISCORD_TOKEN" -c <channel-id> -f Json -o data/discord/import/
```

You can also use the DCE GUI with the **JSON** format.

**2. Scheduled sync.** The `discord-sync` cron runs hourly. It does nothing until an account is connected.
1. Run `bun run setup discord`. It downloads the self-contained DiscordChatExporter CLI into `data/discord/dce`, and the extension finds it automatically. Set `dceCommand` only to use a different copy.
2. Open the Shale web interface → **Accounts** → **Discord** and connect a token:
   - **User token:** reads your servers and DMs.
   - **Bot token:** reads only servers the bot has joined (it needs the Message Content intent). This is the option that stays within Discord's terms.

   The token is checked against Discord and stored in `data/credentials.json` (owner-only). It is never shown in the browser again and reaches the exporter only through its environment. On a headless setup, `DISCORD_TOKEN` in `data/.env` is a fallback.
3. That's it. With the default `syncScope: "all"`, each run:
   - lists every server and DM the account can see
   - exports each channel (with its threads) separately, from that channel's own watermark
   - on a channel's first sync, fetches its full history (`initialSyncDays: 0`)

   An interrupted sweep resumes channel by channel. Channels the account can't read are skipped and retried weekly. The Accounts card shows the last sync's results; trigger a run now from **Overview** with `discord-sync`. To limit what's synced, set `syncScope` to `"selected"` and list `channels`, `guilds`, and/or `includeDMs`.

   If a thread export fails while other exports succeed, those completed files are ingested and the channel watermark stays unchanged. The next run retries the missing history.

> ⚠️ Automating a user account ("self-botting") is against Discord's Terms of Service. Read-only exports are rarely flagged, but the risk is yours.

## Indexing

Raw messages are stored in `discord_messages` and never indexed directly. Each conversation is split into **windows**:
- A silence longer than `gapMinutes` starts a new window.
- A window is also cut at `maxWindowMessages` messages or `maxWindowChars` characters.
- The newest window is indexed only after `idleMinutes` of silence.

Each window becomes one `chat_session` source, with URI `discord://channel/<id>#window=<first message id>`:
- **Verbatim chunks** hold the transcript (`[HH:MM] Name (↪ Other): text [image: x.png] {👍×2}`).
- **The synthetic summary** comes from the chat LLM, or a heuristic when `summarize` is off.
- **Edited messages** re-index their window in place.
- **Backfilled history** replaces windows that overlapped it.

Graph:
- **`Person` (or `Bot`)** per author, with an `external:discord` alias holding the user id, and a `PARTICIPATED_IN` link to the conversation.
- **`Conversation`** per channel, linked `PART_OF` its **`Server`**.
- **`ChatSession`** per window, carrying `SUMMARY` and `COVERS_TOPIC` claims (proposed, from the LLM).
- **A `conversation` event** listing the participants.

Checkpoints let `recover.ts` commit prepared windows after a crash without calling the LLM again. `source:refresh` re-summarises a window from the stored messages.
