# AI chats

Ingests your conversations with **ChatGPT**, **Claude**, and **Gemini**.

None of these services offers an API for reading your chat history. Capture runs in the [Shale Chrome extension](../../scripts/browser-chrome-extension/README.md) through this extension's module (`chrome/`). The module reads conversations from the tabs where you are already signed in, using the same requests the sites' own pages make. It needs no passwords or tokens.

## Setup

1. Start Shale (`bun run main/index.ts`). This extension loads automatically.
2. Run `bun run browser:build`, then load or **Reload** the unpacked extension from `scripts/browser-chrome-extension` in `chrome://extensions`.
3. Open the extension popup. The **AI chats** section shows each provider's status, a **Capture this chat** button, and **Sync** buttons for ChatGPT and Claude.

## How conversations are captured

| Provider | Opened conversations | Full history | Source |
|---|---|---|---|
| ChatGPT (`chatgpt.com`) | Captured about 20 seconds after you open one, and re-checked every few minutes while its tab is visible | **Sync ChatGPT** walks your conversation list and fetches every conversation that changed since the last sync | The web app's `/backend-api` JSON (the same shape as a ChatGPT data export) |
| Claude (`claude.ai`) | Same as ChatGPT | **Sync Claude** works the same way | The web app's `/api/organizations/…/chat_conversations` JSON |
| Gemini (`gemini.google.com`) | Read from the open page | Not available: Gemini has no usable history endpoint | Page content (best effort; selectors live in `chrome/inject/gemini-dom.ts`) |

Details:
- **Sync** uses an open tab of the site, or opens one in the background and closes it afterwards. It resumes after browser restarts, and pauses for a few minutes if the site rate-limits. While a ChatGPT or Claude tab is open, a background sync also runs every `autoSyncMinutes`.
- **Only the active branch is kept.** If you edit a prompt or regenerate a reply, the abandoned branch is removed from Shale and the affected windows are re-indexed. Hidden system and context messages are skipped, as are tool calls, tool output, and reasoning ("thinking") blocks. Uploaded files and images are recorded by name only.
- **Gemini.** Page captures contain only the turns the page has loaded, so scroll up in long Gemini chats to include older turns. Gemini shows no message times, so a turn takes the time it was first captured.
- **No double capture.** While this module is enabled, the browser module does not also capture these sites as ordinary web pages.
- **Missing from a sync?** If a conversation doesn't appear in a site's main list (for example, one inside a ChatGPT project), opening it captures it.

> **Terms of service.** ChatGPT and Claude are read through their sites' private web endpoints using your own session. The module reads only. It fetches slowly (`fetchDelayMs`) and backs off when rate-limited, but the sites can change these endpoints at any time.

## Indexing

Snapshots arrive at `POST /ingest` with `target_processor: "ai-chats"`. The wire contract is in `contract.ts` and is shared with the Chrome module. Messages are stored per provider in the shared `sdk/chat` message log (tables `ai_chatgpt_*`, `ai_claude_*`, `ai_gemini_*`). Every 5 minutes, the `ai-chats-index` cron does the following:
- Cuts conversations into windows: a silence longer than `gapMinutes` starts a new one, and long chats are split by `maxWindowChars`. The newest window waits `idleMinutes` so an ongoing chat is summarised once.
- Indexes each window as one `chat_session` source, with origin `chatgpt`, `claude`, or `gemini` and URI `<provider>://conversation/<id>#window=<first message>`, plus an LLM summary.
- Adds you (`userName`, a `Person`) and the assistant (a `Bot`) as participants of a `Conversation` entity.

Assistant replies are indexed in full. Because long replies fill windows quickly, a long chat becomes several sources.

`source:refresh` works per origin. Checkpoint recovery commits windows that were summarised but not yet saved.

## Privacy

Chats with assistants are often personal. Their origins default to the `private` tier (`originTiers` in `data/access.json`), so the `cloud` profile cannot read them. To exclude a provider entirely, remove it from `providers`. The Chrome module then stops capturing it, and the server skips anything still queued.

## Settings

```text
settings list ai-chats
settings set ai-chats providers '["chatgpt","claude"]'
settings set ai-chats userName "Sam"
settings set ai-chats autoSyncMinutes 0
cron run ai-chats-index
```

Changes take effect without restarting. The Chrome module reads `providers`, `autoSyncMinutes`, `fetchDelayMs`, and `maxConversationsPerSync` from `/connectors/ai-chats/policy`. It refreshes them when the popup opens and every 30 minutes.
