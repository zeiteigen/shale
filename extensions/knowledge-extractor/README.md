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

Phase 1 completes chat requests and checkpoints their outputs. Each extracted claim/event must cite an exact substring of a supplied verbatim chunk. Synthetic chunks are excluded to avoid feeding generated interpretations back as primary evidence. Only the configured prefix of each source is supplied; extraction does not promise complete coverage of longer sources.

Phase 2 atomically commits entities, claims, events, evidence, checkpoint resolution, and per-revision progress. It reuses existing source embeddings and makes no embedding requests. Recovery commits saved outputs without repeating chat calls. Model failures leave earlier checkpoints available; graph commit failures roll back the whole commit batch. A persistent renewable lease prevents overlapping extraction runs and expires after a crashed worker.

Every LLM assertion starts proposed and can be reviewed in the visualizer. Exact-quote validation confirms that evidence exists, not that the assertion is semantically correct. Model-supplied review status, namespaces, and dependencies are discarded. Source changes during processing keep evidence on the original revision and mark affected claims stale.

Entity identity is scoped to source, entity type, and label to avoid merging unrelated people solely by name. Use graph identity correction to confirm cross-source matches. Revised source hashes create new extraction work; identical revisions already completed are skipped. Renamed entities may require identity correction.

Read the [graph SDK reference](../../sdk/graph/README.md) for storage, retrieval, events, and lifecycle APIs.

Connector-owned source identities are linked to extracted entities through proposed `MENTIONS_ENTITY` claims with exact revision evidence. Image sources are excluded from textual extraction, including older vision descriptions labeled verbatim. Generated chunks from other sources are also excluded.
