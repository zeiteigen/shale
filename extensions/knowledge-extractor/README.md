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

The model links a mention to a known entity by id, so "Northbridge High Performance Computing club" in an email can match the "NHPC" seen on Discord without embeddings. Entity types follow `lib/graph/ontology.ts`.

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

Computed timestamp fields additionally require a date/time stated in a cited quote, at matching precision: an ISO form, or an expression the temporal tagger (`lib/graph/temporal.ts`) normalises to exactly that value, such as "Oct 15, 11:59 PM EST" or "tomorrow" relative to the source's creation time. Year-only and month-only dates remain text; they do not become an invented precise event timestamp.

## Deterministic tier

`deterministic.ts` reads what it can from a window without a model, with its own graph `method`:

- **`gazetteer`:** registry entities found by an Aho–Corasick automaton over registry names, aliases, and acronym keys (`lib/graph/gazetteer.ts`). Ambiguous surfaces are settled by graph-neighbour overlap with other linked entities, or dropped. The matched words become evidence.
- **`pattern`:** new mentions typed by their form (`lib/graph/mention-typing.ts`): "… University" is an Organization, "CS 136" a Course, "… Fellowship" an Opportunity. Unknown heads stay untyped for the model.
- **`temporal`:** `HAS_DEADLINE` and `SCHEDULED_FOR` claims with ISO values, quoting the sentence.
- **Connector involvement:** from recorded participants. The user present makes a participant (author when theirs is the first message). Other people only makes an observer, except in email, whose participants are only the senders.

`deterministicMode` (default `shadow`) controls it:

- **`shadow`:** records the verdict in `graph_shadow_decisions` (kind `extraction`, method `deterministic-extraction`). The commit attaches the model's entities, involvement, and dates beside it.
- **`active`:** also gives the gazetteer's entities to the model, merges deterministic entities and claims into the extraction, and lets structural involvement override the model's.
- **`skipLlmWhenCovered`** (default false, active mode only): skips the model for windows whose every name is linked or typed. The digest then gets an extractive summary (method `extractive`).

`predicateSchema` (default `active`) maps model predicates onto the closed, typed schema in `lib/graph/predicates.ts` (about 50 predicates with domain and range) and lists it in the prompt. Unmapped wording becomes `RELATED_TO` with `qualifiers.label`. The model's original predicate is always kept in `qualifiers.rawPredicate`, so the mapping is lossless and can be replayed. `shadow` records only `qualifiers.canonicalPredicate`.

To measure the tier against stored digests, without writing anything, run `bun extensions/knowledge-extractor/eval-deterministic.ts data/production.db [sample]`.

## Email templates

Bulk mail follows templates. `templates.ts` reads it with wrappers instead of a model call per message (`lib/graph/templates.ts`):

1. **Clustering.** Raw messages from the email connector's store are grouped by sender address and subject skeleton. The skeleton masks numbers, dates, handles, quoted strings, and runs of capitalised words, and similar skeletons of one sender merge. A sender's leftover messages (promotions with ever-new subjects) form one residual cluster.
2. **Induction.** A cluster with at least `templateMinMembers` messages is aligned line by line (center-star LCS), then token by token within variable lines. The result is a wrapper: constant lines plus numbered slots. A wrapper is kept when at least that many members align at `templateMinAlignment`. Templates are re-induced only after their cluster grows by half; at most `maxTemplateInductionsPerRun` per run.
3. **Labelling.** One model call per template (`maxTemplateLabelsPerRun` per run, outside transactions) types each slot as an entity type or a literal (date, deadline, amount, url, text, ignore). It also gives the template's claims in the closed predicate schema, a verdict (`informative` or `boilerplate`), involvement, a summary sentence with slot placeholders, and an optional activity. Answers are validated strictly against the wrapper and the schemas.
4. **Extraction.** When every message in an email source aligns with a labelled template, the digest is built from slot values. Entities, claims, and the summary carry method `template`, with the exact slot text as evidence. Dates go through the temporal tagger. Boilerplate templates yield an empty extraction whose summary is the subject. A score below the threshold means the template drifted, and the model reads the message. Informative matches whose unread variable text (bodies typed `text` or `ignore`) is large also go to the model.

`templateMode` (default `shadow`):

- **`shadow`:** records the template digest in `graph_shadow_decisions` (kind `template`). The model still runs, and the commit attaches its entities, predicates, involvement, and summary beside it.
- **`active`:** commits the template digest and skips the model. With `deterministicMode: active`, gazetteer links are merged in.

The registry lives in `graph_email_templates` and `graph_email_template_members`. These are operational tables, hidden from scoped profiles. `templateVerdict(db, sourceId)` and `boilerplateSources(db)` expose template verdicts, for example to source-filter. To measure coverage and agreement on an in-memory copy of a database, run `bun extensions/knowledge-extractor/eval-templates.ts data/production.db [--no-llm] [--label-cache file]`.

Each model response has an 8,192-token output limit, with concise claim limits and reasoning disabled. Truncated output is rejected before checkpointing. Native chat batches have one total request deadline that also bounds SDK retries, preventing a timeout from repeatedly submitting the same expensive generation.

Invalid schema or nonmatching evidence quotes receive validation feedback and at most three attempts. The latest rejected response is retained under `extraction-rejected:<revisionId>` for diagnosis and removed after a valid correction. Transport failures propagate immediately. Exhausted attempts do not advance the source cursor or commit unsupported claims.

An invalid or token-truncated window does not block other validated windows in the same batch. Truncated output is retained without an immediate repeat generation. The run commits valid results and reports how many windows were rejected and retained for retry.

Evidence matching permits whitespace differences from PDF line breaks and repairs a wrong chunk index only when the wording has a unique location in the supplied window. Stored evidence uses the exact original source substring and offsets. Changed wording or punctuation is rejected. Rejected windows receive a later turn so they cannot permanently starve fresh sources.

Each extracted mention keeps a source-scoped identity (source, type, label). Cross-source identity comes from the resolver's audited, reversible merges; people are never merged by name alone. Revised source hashes create new extraction work; identical revisions already completed are skipped. Renamed entities may require identity correction.

Read the [graph SDK reference](../../sdk/graph/README.md) for storage, retrieval, events, and lifecycle APIs.

Connector-owned source identities are linked to extracted entities through proposed `MENTIONS_ENTITY` claims with exact revision evidence. Image sources are excluded from textual extraction, including older vision descriptions labeled verbatim. Generated chunks from other sources are also excluded.
