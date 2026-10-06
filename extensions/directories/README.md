# Directories

Recursively index selected local folders into Shale, without requiring an Obsidian vault. The host discovers this extension automatically and scans on startup and every six hours.

Choose folders in **Settings → directories** in the local web interface, or use the settings CLI:

```bash
bun run settings set directories directories '["/home/munch/Documents", "/home/munch/Projects/notes"]'
```

Start the host with `bun run start` and open `http://localhost:7425`. Run `directories-parser-cron` from **Overview → Background jobs**, or use the web command console:

```text
cron run directories-parser-cron
```

The default selection is empty. Settings are read freshly for each run. Paths may be absolute, relative to the daemon's working directory, or start with `~/`. Overlapping selections are deduplicated. Subdirectories are scanned recursively; hidden entries, nested symlinks, and `node_modules`, `vendor`, `dist`, and `build` directories are skipped by default.

Documents are sent to `process-document` and images to `process-image` through the typed `file:can-process` and `file:process` message channels. Both processors must be loaded by the host; invoking this extension alone does not register them. The default extension list covers Markdown, text, CSV, HTML, PDF, EPUB, RTF, modern Office/OpenDocument files, and common images. Set `fileExtensions` to an empty array to ask installed processors about every regular file. Unsupported files are skipped. Scanned PDFs need OCR before the document processor can extract text.

All parsing, optional document summaries, and vision calls across every selected folder finish before any embedding requests. Phase 1 saves each prepared file to a durable checkpoint. Phase 2 embeds chunks in bounded batches and commits sources, vectors, graph evidence, directory membership, per-file watermarks, and checkpoint removal together. A `source:ingested` event is published after commit.

File watermarks record modification time, change time, size, and inode, so an older file copied into a folder is still discovered. Unchanged files are skipped. Failed files remain eligible for retry; completed files are not repeated when another file fails. Files changed during processing are retried rather than marked complete. Recovery reuses prepared chunks without repeating chat calls; stale or deleted-file checkpoints are discarded for the next scan. Set `forceAll` to `true` for a full rebuild, then reset it to `false`.

Sources use canonical, encoded `file://` URIs with origin `directories` and namespace `directories` by default. Source identity is shared across Shale, so selecting a folder already indexed by another connector updates those same sources. Removal from disk or from the selected folders does not delete previously ingested knowledge.

See `settings.help.json` for exclusions, recursion, namespace, file size, processing timeout, and embedding batch settings. Summaries and format-specific extraction settings remain in `process-document`; vision settings remain in `process-image`.
