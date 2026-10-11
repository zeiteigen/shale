# Discord

Ingests Discord server channels, threads, DMs, and group DMs. Discord has no official API for reading a personal account's messages, so this extension uses the community tool [DiscordChatExporter](https://github.com/Tyrrrz/DiscordChatExporter) (DCE) and its JSON export format.

## Feeds

**1. Import folder (always on).** The `discord-import` cron runs every 15 minutes and at startup. It ingests any DCE JSON file under `importDir` (default `data/discord/import/`). It skips files whose size and modification time haven't changed. Export files by hand with:

```bash
DiscordChatExporter.Cli export -t "$DISCORD_TOKEN" -c <channel-id> -f Json -o data/discord/import/
```

You can also use the DCE GUI with the **JSON** format.

**2. Scheduled sync (opt-in).** The `discord-sync` cron runs hourly and calls the DCE CLI for every target in `channels`, `guilds`, and `includeDMs`.
- It asks only for messages newer than the last sync (`--after`, with a watermark per target).
- The first sync of a target reaches back `initialSyncDays`.

To enable it:
1. Install the [DCE CLI](https://github.com/Tyrrrz/DiscordChatExporter/releases). If it isn't on `PATH`, point `dceCommand` at it, e.g. `["dotnet", "/opt/dce/DiscordChatExporter.Cli.dll"]`.
2. Open the Shale web interface → **Accounts** → **Discord** and connect a token:
   - **User token**: reads your servers and DMs.
   - **Bot token**: reads only servers the bot has joined (it needs the Message Content intent), and is the ToS-compliant option.

   The token is checked against Discord, stored in `data/credentials.json` (owner-only), and never shown in the browser again. **Check connection** and **Disconnect** are on the same card. On a headless setup you can instead set `DISCORD_TOKEN` in `data/.env`, which is used only when no account is connected.
3. Set `syncEnabled` to `true` and list your targets. The token is passed to the exporter through its environment, never on the command line.

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
