# Database backup

Backups snapshot the entire local SQLite database with `VACUUM INTO`. This includes knowledge claims, status history, evidence, immutable source revision chunks, events, participants, relation definitions, identity aliases, merges, and connector recovery checkpoints. No table allowlist or additional graph export is needed.

Settings are read for each execution. Existing startup, cron, retention, and message-triggered backup behavior applies to the richer database without changes.
