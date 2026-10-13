# Knowledge extractor

Digests each source revision in one model call. A digest has these parts:

- **Summary:** what happened or what the source says.
- **Involvement:** how the user took part: `author`, `participant`, `observer`, or `none`.
- **Activity:** whether the user is pursuing something that spans time, such as applying to a club or building a project.
- **Claims and events:** grounded in exact quotes.
- **Typed entities:** each has a description, search keys, and identifying URLs.

Digests are written to `graph_source_digests`, and the `episodes` extension assigns them to cross-source stories.

To reproduce missing digests for known sources, run `bun scripts/digest-sources.ts <source-id> [source-id ...]`.
It uses the regular settings, lease, validation, and checkpoints and processes one bounded window per selected source.
Completed revisions are skipped; long sources may need another pass. Exit code 2 means the extractor is already busy,
and exit code 1 reports rejected output or an invalid source. The normal cron continues processing the backlog.

Connector participant records override an invented personal activity in someone else's conversation. To repair
cached digests from older versions, run `bun extensions/knowledge-extractor/repair-digests.ts`. It clears those
unsupported activities, records the previous value and reason in extension state, and reopens episode assignment.
The repair uses the extractor lease and returns exit code 2 when extraction is busy.

The prompt gives the model more than the text:

- **Metadata:** origin, time, venue, and participants. The user is marked, once identity resolution has found their accounts.
- **Known entities:** a shortlist of up to 15 registry entities, found by identity keys and FTS over the source's rare terms.
- **Ongoing episodes:** a shortlist of up to 5.

The model links a mention to a known entity by id, so "University of Waterloo High Performance Computing club" in an email can match the "UWHPC" seen on Discord without embeddings. Entity types follow `lib/graph/ontology.ts`.

Every entity grounded in the text is passed to the identity resolver (`sdk/graph/identity.ts`):

- It merges on strong keys, such as the same GitHub owner or email address.
- It merges on a model match corroborated by a name or acronym key.
- Otherwise it queues the pair for adjudication.

The resolved canonical entity is linked to the source (`source_entities`) and to the evidence chunks (`chunk_entities`), so retrieval and episodes see it. Model-supplied match ids outside the shortlist, and URLs that do not occur in the source, are discarded.

The digest runs every ten minutes on up to `maxSourcesPerRun` revisions (default 12). The newest sources go first, with conversations, mail, notes, and pages ahead of history and searches. Per-visit `browser_activity` and `web_session` records are skipped, because their pages are digested. It does not run automatically at host startup.

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

Later windows reset cached episode signals and return the digest to pending assignment, so entities discovered beyond
the prefix can connect the source to an episode even after an earlier assignment found no match.

Every LLM assertion starts proposed and can be reviewed in the visualizer. Exact-quote validation confirms that evidence exists, not that the assertion is semantically correct. Model-supplied review status, namespaces, and dependencies are discarded. Source changes during processing keep evidence on the original revision and mark affected claims stale.

Computed timestamp fields additionally require the exact ISO date/time in a cited quote, at matching precision. Year-only or textual dates remain text; they do not become an invented precise event timestamp.

Each model response has an 8,192-token output limit, with concise claim limits and reasoning disabled. Truncated output is rejected before checkpointing. Native chat batches have one total request deadline that also bounds SDK retries, preventing a timeout from repeatedly submitting the same expensive generation.

Invalid schema or nonmatching evidence quotes receive validation feedback and at most three attempts. The latest rejected response is retained under `extraction-rejected:<revisionId>` for diagnosis and removed after a valid correction. Transport failures propagate immediately. Exhausted attempts do not advance the source cursor or commit unsupported claims.

An invalid or token-truncated window does not block other validated windows in the same batch. Truncated output is retained without an immediate repeat generation. The run commits valid results and reports how many windows were rejected and retained for retry.

Evidence matching permits whitespace differences from PDF line breaks and repairs a wrong chunk index only when the wording has a unique location in the supplied window. Stored evidence uses the exact original source substring and offsets. Changed wording or punctuation is rejected. Rejected windows receive a later turn so they cannot permanently starve fresh sources.

Each extracted mention keeps a source-scoped identity (source, type, label). Cross-source identity comes from the resolver's audited, reversible merges; people are never merged by name alone. Revised source hashes create new extraction work; identical revisions already completed are skipped. Renamed entities may require identity correction.

Read the [graph SDK reference](../../sdk/graph/README.md) for storage, retrieval, events, and lifecycle APIs.

Connector-owned source identities are linked to extracted entities through proposed `MENTIONS_ENTITY` claims with exact revision evidence. Image sources are excluded from textual extraction, including older vision descriptions labeled verbatim. Generated chunks from other sources are also excluded.
