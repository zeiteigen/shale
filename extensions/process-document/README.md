# process-document

Local text extraction and structural chunking for PDF, Word (`.docx`), PowerPoint
(`.pptx`), Excel (`.xlsx`), OpenDocument (`.odt`, `.odp`, `.ods`), RTF, plain text,
CSV, Markdown, HTML, and EPUB. Uses [officeparser](https://github.com/harshankur/officeParser)
and a local PDF.js worker. No Microsoft Office or LibreOffice installation is required.

The host discovers `manifest.json` and registers `setup.ts` automatically on startup.
As with `process-image`, this is a processing service: it returns chunks, entities,
and edges for the caller to ingest. It does not scan directories or write sources
to the database. OCR and vision page caches allow repeated calls to resume after
interruption; the ingesting extension owns document checkpoints and ingestion transactions.

## Message API

```ts
const document = await sdk.messages.request("file:process", {
  filePath: "/path/to/report.docx", // Local paths or encoded file:// URLs
  contextEntity: "Research vault",
  options: { namespace: "research" },
}, { target: "process-document", timeoutMs: 120_000 });

const batch = await sdk.messages.request("files:process", {
  files: [
    "/path/to/paper.pdf",
    { filePath: "/path/to/slides.pptx", contextEntity: "Presentations" },
  ],
}, { target: "process-document", timeoutMs: 300_000 });

const capability = await sdk.messages.request("file:can-process", {
  filePath: "/path/to/paper.pdf",
}, { target: "process-document" });
```

Also supports `file:process-batch`, `file:process` with `files` or `filePaths`, and
`files:can-process` with `filePaths`. When `target` is omitted, routing selects this
extension for supported document paths and leaves images to `process-image`.
The bus selects one processor per request: send documents and images as separate
batches. Capability results describe this provider's formats and do not aggregate
the capabilities of other extensions. Capability checks inspect the format and
settings, not the file's existence or contents. Extensionless paths can use a
supported `mimeType` or format name in `fileType`.

Successful responses use `fileType: "document"`; `metadata.format` gives the exact
format. Each extracted chunk has `chunk_type: "verbatim"`, with available
`pageNumber`, `slideNumber`, `sheetName`, or `closestHeading` metadata. Document
metadata includes title, author, timestamps, structural counts, parser warnings,
and a SHA-256 `assetHash`. The returned document entity uses the file URI as its
identity, and `contextEntity` adds a `CONTAINED_IN` edge.

## Models and resource limits

Parsing is local and runs in a dedicated worker, one file at a time. A file size
limit and parsing deadline bound work; cancellation terminates the worker.
Parsing requires no model calls. Optional summaries are disabled by default.

Set `enablePdfOcr` to `true` to transcribe PDF pages without a text layer with installed
`pdftoppm` (Poppler) and `tesseract` tools. `ocrLanguage` selects installed
language data, for example `eng`; language data is never downloaded. OCR stays
on the CPU. Page numbers, the OCR engine, language,
confidence scores and a transcription warning are retained in the document metadata.
Each completed page is persisted in extension state under its PDF fingerprint
and OCR configuration. A parser deadline or cancellation retains completed
transcripts; rerunning the cron resumes the remaining pages. The document is
ingested only after all pages finish. Searchable pages retain their original parser
output; missing pages in mixed PDFs are transcribed separately.

With `enablePdfVision`, pages below `pdfVisionMinConfidence` (default 60) are
transcribed by the chat vision model during preparation. Each completed response
is cached by PDF fingerprint, page, and model. These chunks are `synthetic` and
record their model; they replace uncertain OCR text while preserving page numbers.
The prompt preserves visible handwriting and equations and marks illegible words
as `[unclear]`. Explicitly blank pages do not produce text chunks. A failed vision
request leaves the document unfinished so the caller can retry from cached pages.

`options.customPrompt` overrides the summary instruction, and `options.timeoutMs`
overrides the per-file parsing and summary deadlines. The message request's timeout
is a separate deadline covering the entire batch; increase it for larger batches.

Summaries are additional `synthetic` chunks with proposed `DOCUMENT_SUMMARY`
knowledge claims. `summaryMaxChars` bounds the source supplied to the model;
`inputTruncated` records when only the document's beginning was summarized. A
summary failure retains the extracted text and records `metadata.summaryError`.

One parsing failure does not stop other files. Failed files retain extracted
chunks for inspection or retry.
`totalProcessed` counts successful files; `totalFailed` and `errors` describe failures.
Cancellation rejects the whole request and stops subsequent work.

## Settings

Settings are read from disk on each invocation and capability check. Available
settings and validation ranges are in `settings.help.json`.

```bash
bun run settings list process-document
bun run settings set process-document summarizeDocuments true
bun run settings set process-document chunkSize 2400
bun run settings set process-document includeNotes false
```

Schema fallbacks: 50 MiB source limit, 60 second parsing and summary deadlines, 1,800
characters per extracted chunk, notes included,
and summaries disabled. `supportedExtensions` can disable built-in formats;
adding a name does not add a parser.
The checked-in settings raise the source limit to 300 MiB and the parsing deadline
to 300 seconds for large scanned documents; the summary deadline remains 60 seconds.

## Extraction limits

- Legacy binary `.doc`, `.ppt`, and `.xls` require conversion to `.docx`, `.pptx`,
  and `.xlsx` first.
- Scanned PDF pages require `enablePdfOcr` and its local tools. Other embedded images
  are not described; use `process-image` separately when visual analysis is needed.
- Password-protected documents are unsupported by this extension.
- Remote URLs are unsupported; callers must download documents to local files.
- Chunk text represents parsed content, tables, and optional notes. It does not
  reproduce visual layout or guarantee PDF reading order in every complex layout.

## Verification

```bash
bun test tests/process-document-parsers.test.ts tests/process-document-extension.test.ts
bun run typecheck
```

Vision transcription chunks retain original page locations and proposed `VISION_TRANSCRIPTION` claims with the model identity. Native extraction and generated transcription remain distinguishable in the graph.
