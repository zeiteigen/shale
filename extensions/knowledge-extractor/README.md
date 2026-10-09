# Knowledge extractor

Extracts grounded entity claims, typed properties, and multi-participant events from ingested source revisions. It runs every four hours and processes at most five sources per invocation by default. It does not run automatically at host startup.

To run it immediately in the daemon CLI:

```text
cron run knowledge-extractor-cron
```

Settings are read fresh on each invocation. Configure them with the existing settings CLI:

```bash
bun run settings set knowledge-extractor maxSourcesPerRun 10
bun run settings set knowledge-extractor maxContentChars 20000
bun run settings set knowledge-extractor enabled false
```

Preparation completes chat requests and checkpoints their outputs. Each extracted claim/event must cite an exact substring of a supplied verbatim chunk. Synthetic chunks are excluded to avoid feeding generated interpretations back as primary evidence. Long sources are processed in bounded windows of `maxContentChars` characters. Each successful window saves a durable cursor; a revision is marked complete only after its last verbatim chunk. Subsequent cron runs continue pending windows, giving new sources a turn first. Evidence offsets remain relative to the original revision chunks.

The commit atomically writes entities, claims, events, evidence, checkpoint resolution, and per-revision progress. Recovery commits saved outputs without repeating chat calls. Model failures leave earlier checkpoints available; graph commit failures roll back the whole commit batch. A persistent renewable lease prevents overlapping extraction runs and expires after a crashed worker.

Every LLM assertion starts proposed and can be reviewed in the visualizer. Exact-quote validation confirms that evidence exists, not that the assertion is semantically correct. Model-supplied review status, namespaces, and dependencies are discarded. Source changes during processing keep evidence on the original revision and mark affected claims stale.

Computed timestamp fields additionally require the exact ISO date/time in a cited quote, at matching precision. Year-only or textual dates remain text; they do not become an invented precise event timestamp.

Each model response has an 8,192-token output limit, with concise claim limits and reasoning disabled. Truncated output is rejected before checkpointing. Native chat batches have one total request deadline that also bounds SDK retries, preventing a timeout from repeatedly submitting the same expensive generation.

Invalid schema or nonmatching evidence quotes receive validation feedback and at most three attempts. The latest rejected response is retained under `extraction-rejected:<revisionId>` for diagnosis and removed after a valid correction. Transport failures propagate immediately. Exhausted attempts do not advance the source cursor or commit unsupported claims.

An invalid or token-truncated window does not block other validated windows in the same batch. Truncated output is retained without an immediate repeat generation. The run commits valid results and reports how many windows were rejected and retained for retry.

Evidence matching permits whitespace differences from PDF line breaks and repairs a wrong chunk index only when the wording has a unique location in the supplied window. Stored evidence uses the exact original source substring and offsets. Changed wording or punctuation is rejected. Rejected windows receive a later turn so they cannot permanently starve fresh sources.

Entity identity is scoped to source, entity type, and label to avoid merging unrelated people solely by name. Use graph identity correction to confirm cross-source matches. Revised source hashes create new extraction work; identical revisions already completed are skipped. Renamed entities may require identity correction.

Read the [graph SDK reference](../../sdk/graph/README.md) for storage, retrieval, events, and lifecycle APIs.

Connector-owned source identities are linked to extracted entities through proposed `MENTIONS_ENTITY` claims with exact revision evidence. Image sources are excluded from textual extraction, including older vision descriptions labeled verbatim. Generated chunks from other sources are also excluded.
