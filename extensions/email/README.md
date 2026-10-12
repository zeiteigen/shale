# Email

Email ingests conversations from local `.eml` and `.mbox` files and can sync mailboxes over implicit TLS with IMAP. IMAP uses Python's standard library; Python 3.10 or newer is required, with no pip dependencies.

The connector is read-only. It uses IMAP `EXAMINE` and `BODY.PEEK`, connects with verified implicit TLS (default port 993), and never sends mail or changes mailbox state. It does not mark messages read, archive, delete, or move mail. Raw MIME is fetched for parsing; attachment payloads are discarded, with only filenames and types indexed. Plain text is preferred; HTML is stripped when a plain-text alternative is unavailable. Remote resources are not fetched. OAuth-only servers are not supported; use an app password or import local exports.

Messages are deduplicated by `Message-ID` where available and threaded using `References` and `In-Reply-To`. Without Message-ID, a stable MIME hash identifies the message. IMAP progress is scoped to the account and mailbox, and tracks UID validity with UID cursors. Message-ID matching deduplicates copies found in multiple folders and local imports. Thread windows become searchable sources with summaries and sender `Person` entities. Subject, sender, To/Cc/Bcc, bodies, and quoted replies are preserved in transcripts. Missing/invalid dates use a deterministic epoch fallback. Imported email has a private classification floor even with an existing access policy; the classifier model cannot lower it. Users can still change tiers manually.

## Connect and sync

Connect an IMAP account from the web interface's **Accounts** page with the server host, port, username, and password or app password. The account credentials are stored by Shale's credentials service. For headless use, set `host`, `port`, and `username` in settings and provide the password through the environment variable named by `passwordEnv` (default `EMAIL_PASSWORD`).

### Gmail with 2FA

Keep Google 2-Step Verification enabled. Create an app password named **Shale** at [Google App passwords](https://myaccount.google.com/apppasswords), then choose **Gmail (app password)** on Shale's Accounts page. Enter your full email address and the generated 16-character app password. Pasting the spaces between character groups is supported. This method sets `imap.gmail.com` and TLS port `993` automatically. In the generic IMAP form or headless settings, use those same server details and app password.

Your normal Google password, authenticator code, and backup codes cannot complete this connector's IMAP sign-in. Google may hide app passwords for accounts with Advanced Protection, some managed work/school accounts, or 2-Step Verification configured only with security keys. See [Google's app-password guide](https://support.google.com/accounts/answer/185833). This connector currently requires local `.eml`/`.mbox` exports for accounts that cannot use app passwords; it does not implement Google's browser OAuth flow. A Google account password change revokes app passwords, so generate a new one if sign-in stops afterward.

Set `syncEnabled` to `true` to enable scheduled sync. The `email-sync` cron runs hourly. A first sync fetches full history by default; set `initialSyncDays` to a positive number to limit it. Each run fetches at most `maxMessagesPerMailbox` messages per mailbox and resumes from its saved cursor. The `email-import` cron scans the import folder every 15 minutes and once at startup; imports work without an IMAP account.

Only `INBOX` is synced by default. Add Sent or archive folders to `mailboxes` using their exact server names, for example `bun run settings set email mailboxes '["INBOX","Sent"]'`. One IMAP account can be connected at a time. Disconnecting removes stored credentials; an explicitly configured environment fallback can still enable headless sync. Removing mail on the server does not delete the local ingested history.

Place `.eml` or `.mbox` files anywhere under `./data/email/import` (the default `importDir`). Setup creates the import folder and checks for Python. Run `bun run setup email` to run email setup, or `bun run setup` to set up all extensions.

## Settings and cron controls

Use the daemon CLI to inspect or change settings; changes take effect without restarting:

```text
settings list email
settings describe email
settings set email syncEnabled false
settings set email importDir ./data/email/import
cron list
cron run email-import
cron run email-sync
```

The standalone settings command is also available, for example `bun run settings list email` and `bun run settings set email syncEnabled false`. See the [IMAP4rev2 protocol](https://www.rfc-editor.org/rfc/rfc9051) and Python [`imaplib`](https://docs.python.org/3/library/imaplib.html) documentation.
