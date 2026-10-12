# Obsidian connector

Vault ingestion prepares note expansion, image analysis, and document parsing across configured vaults. Each prepared file keeps its parsed metadata, link resolutions, provenance, and namespace in a checkpoint. Source chunks, graph assertions, and checkpoint completion commit together. A failed file retains its checkpoint and prevents the discovery batch from advancing its watermarks.

Delegated image batches use each vision request's model timeout rather than a
30-second deadline for the whole batch. Failed processing is left pending for the
next scan, without immediately repeating the batch through individual or local
requests. Successful results in a partial batch are checkpointed and ingested.

Notes, images, documents, and vaults have identities derived from their absolute URI and namespace. Equal titles do not merge files or vaults. Wikilinks resolve against a single discovery index; ambiguous or missing targets remain scoped `NoteReference` nodes. Authored aliases, heading anchors, link order, and raw link text are retained. Image references use the same index and remain `ImageReference` nodes when unresolved. Document wikilinks, PDF embeds (`![[paper.pdf#page=3]]`), and Markdown document links resolve within each vault to `Document` nodes, or scoped `DocumentReference` nodes when missing or ambiguous.

Favicon endpoints and conventional decorative icon assets are omitted from image relationships and from note text used for summaries and retrieval. Citation links, substantive images, and literal code examples are preserved; the original vault files are never rewritten. The same image policy is used by browser capture and web-page parsing before vision analysis.

To repair an older index, run `bun run repair:images` for a dry-run report, then `bun run repair:images --apply`. Add `--source-id <id>` to limit the repair or `--profile <name>` to use another access profile. Dry runs inspect a temporary snapshot. Applying creates a database backup under the database's `backups/` directory, rebuilds generated memory from unchanged original notes, and retracts decorative relationships in an audited transaction per source. Manually edited memory and historical evidence remain available. Changed or unavailable originals are reported for ingestion/retry. The default map hides retired connector image nodes without live support; historical views still show them.

The connector writes accepted `IN_VAULT`, `REFERENCES`, `FEATURES_IMAGE`, and `HAS_TAG` claims with source revision evidence. YAML frontmatter retains typed booleans, numbers, arrays, and nested objects as `PROPERTY:<key>` claims. Frontmatter is also saved verbatim for evidence. Aliases are scoped to the vault URI.

Expanded note context and vision descriptions become proposed claims. Both vision chunks are synthetic. Local image SHA-256 fingerprints participate in source revision identity, so changed image bytes invalidate earlier interpretations even when their description is unchanged.

The default note expansion prompt stays within each note's subject, preserves
uncertainty and attribution, and labels added concepts as related background.
Custom prompt and system templates remain configurable in extension settings.

Direct `ingestFile` and `ingestImageFile` calls use the same commit path as vault ingestion and recovery. Their returned title-based `entities` and `edges`, and `commitVaultGraph`, are legacy compatibility helpers; ingestion already commits the authoritative graph.

Existing files receive these records on their next ingestion. Run the Obsidian cron with `forceAll` enabled to refresh unchanged files; return it to false afterward. Existing title-based nodes are preserved for manual identity review rather than automatically merged with path-based nodes.

## Document attachments

`includeDocuments` defaults to `true`. Every vault discovered in `obsidian.json` or
configured through `customVaults` scans recursively for PDF, DOCX, PPTX, XLSX, ODT,
ODP, ODS, RTF, TXT, CSV, HTML, and EPUB attachments. Hidden folders and
`ignoredDirectories` are skipped. Markdown stays on the existing note pipeline.

The connector calls `process-document` through the typed `file:process` message
channel. The host loads that extension automatically;
standalone SDK callers must register its message handlers on the same bus. Parser
limits, supported formats, and optional summaries are configured in
[process-document](../process-document/README.md). Missing handlers or failed parsing
retain the vault's cursors for retry. The connector never imports another
extension's implementation or silently replaces failed document extraction.

Document attachments use a separate `vault:<path>:documents:mtime` watermark. On
the first scan, older documents are picked up even when the vault's note/image
watermark is already ahead of their modification times. Newly enabling a format
after a document cursor has advanced may require a `forceAll` scan. Existing
unchanged notes also need a `forceAll` scan to gain new document-reference claims.

Each document is checkpointed immediately after preparation, including optional
summaries, so retries and recovery can commit cached chunks without parsing or
calling the chat model again. Document source revisions include the binary
fingerprint, parsed metadata, and chunk content. Parsed metadata and page, slide,
sheet, and heading locations are stored as graph claims linked to source evidence.
Generated summaries remain proposed claims and synthetic chunks.

```bash
bun run settings set obsidian includeDocuments true
bun run settings set obsidian documentExtensions '["pdf", "docx", "pptx"]'
bun run settings set obsidian documentRequestTimeoutMs 180000
```

`ProcessVaultResult.documentsProcessed` counts committed documents;
`documentWatermarkAdvancedTo` reports their cursor. Recovery reports
`recoveredDocuments` separately from the existing `recoveredNotes` count.

Each committed file also records its modification time in the same transaction as
its source, graph evidence, and checkpoint resolution. When one attachment fails,
the vault cursor remains unchanged and retries skip completed files. Edited files
are processed again, and `forceAll` bypasses this per-file progress.
