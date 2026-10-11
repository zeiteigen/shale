# Instagram

Ingests Instagram direct messages (1:1 and group threads). Instagram offers no official API for reading personal DMs, so this extension combines Instagram's own data export with the community library [instagrapi](https://github.com/subzeroid/instagrapi).

## Feeds

**1. Official data export (always on, no account risk).** To get an export:
1. Go to **Accounts Center → Your information and permissions → Download your information**.
2. Request **Messages** in **JSON** format.
3. Unzip the archive into `importDir` (default `data/instagram/import/`).

The `instagram-import` cron (every 30 minutes and at startup) picks up every `messages/inbox/<thread>/message_N.json`. The parser:
- repairs the export's mojibake (UTF-8 stored as Latin-1, e.g. `cafÃ©` → `café`)
- sorts messages oldest-first
- turns shares into link attachments
- leaves notices such as "Liked a message" and calls out of transcripts

To pick up newer messages, drop a newer export in the same folder; duplicates are skipped.

**2. instagrapi sidecar (opt-in).** The `instagram-sync` cron runs every two hours and calls `sidecar/ig_sync.py`, which:
- logs in with a persisted session (`sessionFile`)
- checks the `maxThreadsPerSync` most recently active threads
- fetches only the threads that have new activity

Setup:

```bash
bun run setup instagram
```

This creates a private virtualenv at `data/instagram/venv` and installs instagrapi into it. The extension uses that virtualenv automatically; set `pythonBin` only to use a different interpreter.

Then open the Shale web interface → **Accounts** → **Instagram** and sign in with either method:
- **Username & password.** If Instagram asks for a two-factor or security-challenge code, the card prompts for it. The sign-in helper stays running while you type the code, so Instagram doesn't send a fresh one. The password is kept in `data/credentials.json` (owner-only) so the sync can sign in again when the session expires.
- **Session cookie.** Paste the `sessionid` cookie from a browser where you're logged in. No password is stored, but the session ends if you log out of that browser.

Finally, set `syncEnabled` to `true`. The session is saved to `sessionFile` (owner-only). **Check connection** and **Disconnect** are on the same card; disconnecting deletes the stored credentials and the session. If Instagram later demands verification (`challenge_required`) or rate-limits the account, the sync stops, reports it, and tries again on the next scheduled run; reconnect on the Accounts page to clear a challenge. On a headless setup, `INSTAGRAM_USERNAME` and `INSTAGRAM_PASSWORD` in `data/.env` are a fallback, but they can't complete 2FA.

> ⚠️ instagrapi uses Instagram's private API. Instagram can challenge, rate-limit, or restrict accounts that use it. Consider a low sync frequency and keep this off unless you accept that risk.

### Merging the two feeds

- **Threads:** the export has no thread or user ids, so a thread is recognised across feeds by its set of participant display names. A sidecar thread is merged into the matching exported thread.
- **Messages:** a message with the same author name and text within 2 seconds is treated as the same message, so the sidecar doesn't duplicate exported messages.
- **People:** exported authors are keyed by display name. Sidecar authors are keyed by Instagram user id and carry an `external:instagram` alias. People are never merged by name alone.

## Indexing

This uses the same shared windowing as `extensions/discord` (`sdk/chat`):
- one `chat_session` source per conversation window, at `instagram://thread/<id>#window=<first message id>`
- an LLM summary for each window
- `Person`, `Conversation` and `ChatSession` entities in the graph
- checkpoint recovery and `source:refresh` support

See the Discord README for the window settings.
