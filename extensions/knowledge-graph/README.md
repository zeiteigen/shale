# Knowledge graph service

Registers typed message handlers for graph storage, retrieval, evidence inspection, and identity/review correction. It also runs the `identity-resolver` cron, every 15 minutes and at startup, and the `graph-reasoner` cron, hourly (not at startup).

## Identity resolution

Each run of `identity-resolver` does seven things:

1. **Registry.** On the first run, it indexes existing people, organizations, projects, artifacts, and episodes into the registry (`entity_registry_fts`).
2. **Connector keys.** It gives connector entities their identity keys: Discord users and servers, email senders, and visited or shared pages. Shared keys then merge entities of the same family. For example, a link posted in Discord and a visit to that page become one page. Shared keys link entities of different families instead: a page `REFERS_TO` the repository or account it shows, and a Discord server is `COMMUNITY_OF` the organization with the same name.
3. **Self.** It gathers the user's accounts into one `Person` with stable id `self`. The accounts come from the connected Discord account, the connected mailbox, and the `selfNames`, `selfEmails`, and `selfHandles` settings (for example `["github:example-user"]`).
4. **Duplicate sweeps.** It queues canonical entities that share a name or acronym key for adjudication. A second sweep finds near-duplicate names with no shared key ("Redekop" / "Redekopp"): MinHash-LSH over character 3-grams, verified by 3-gram Jaccard ≥ 0.5, at most `maxNearDuplicatesPerRun` pairs (basis `minhash:<similarity>`).
5. **Exact names.** It settles queued pairs without the model when they share a type and an exact full name, and nothing recorded tells them apart (a "different" verdict, or a merge the user undid). This applies to organizations, concepts, courses, opportunities, products, projects, artifacts, and places. People, events, and pages are excluded. A newly extracted mention merges the same way as it is resolved, so "Global Politics" joins the course already called that instead of waiting for a later run.
6. **Record linkage** (`lib/graph/linkage.ts`). It scores each queued pair with a logistic model over name similarity (Jaro–Winkler, token and IDF-weighted overlap, nicknames and initials, acronyms, email local parts), keys (shared or conflicting emails, domains, Discord accounts), TF-IDF cosine of descriptions, dates, and the graph (shared neighbours, sources, co-participation, time overlap). The weights are learned from the model's own past verdicts: shipped defaults, refit into `extension_state` (`linkage-model-v1`) once a day when `linkageRefitMinLabels` new verdicts have arrived. Rule and linkage decisions are never used as labels. `linkageMode` decides what happens next:
   - `shadow` (default): every score is recorded in `graph_shadow_decisions` (kind `identity`, method `linkage`) and the model's later verdict is attached beside it.
   - `active`: a pair at or above `linkageSameThreshold` is merged (reason `Record linkage (p): linkage p=…`), one at or below `linkageDifferentThreshold` is marked different, and pairs whose groups are cannot-linked are marked different (`cannot-link: …`). People need `linkagePersonSameThreshold` and relational evidence (shared neighbours, email, or domain); dated things need agreeing dates; product editions ("iOS", "Pro", different numbers) never merge by score.
   - `off`: skipped.
7. **Adjudication.** It asks the model about the remaining queued pairs, eight per request, up to `maxAdjudicationsPerRun`. At 0.85 confidence or more, the pair is merged. Between 0.6 and 0.85, a proposed `COREFERS_TO` is written.

Merges are constrained: a merge is refused when any member of one identity group is cannot-linked to any member of the other, so A~B and B~C never pull in a C that was told apart from A. Cannot-links are a merge someone undid and two parties of one event (both hold even against a shared key), plus, for judgements, distinct Discord accounts and recorded "different" verdicts. A refused "same" verdict keeps its label and notes `merge refused: …` in its reason.

Merges are recorded in `graph_identity_changes` and can be undone (`graph:unmerge`, `unmerge_entities`, or the visualizer).

```bash
bun run settings set knowledge-graph selfHandles '["github:example-user"]'
```

```ts
const person = await sdk.messages.request("graph:entity", {
  name: "Alice", type: "Person", namespace: "knowledge",
});
const result = await sdk.messages.request("graph:ingest-claims", {
  claims: [{ subject: person.id, predicate: "ROLE", value: "researcher" }],
});
const inspection = await sdk.messages.request("graph:inspect", {
  claimId: result.claims[0].id,
});
```

## Graph reasoner

`graph-reasoner` (`reason.ts`) discovers relations without the model. It holds a task lease, so runs never overlap. `reasoningMode` decides what it does:

- `shadow` (default): every would-be claim is recorded in `graph_shadow_decisions` (kind `relation`). What the model said about the same pair, or the same source, is recorded beside it. Nothing is written to the graph.
- `active`: the would-be claims are written as proposed claims, with a method per stage, and conflicts are written as `contradicts` links.
- `off`: skipped.

It runs four stages:

1. **Association edges** (`lib/graph/association.ts`, method `association`). It counts which canonical entities appear in the same sources (`source_entities` and digest signals). The self identity, Episodes, connector containers (pages, chats, conversations), and entities in more than `associationMaxDocFraction` of sources are left out.
   - **Scoring.** Each pair seen together in at least `associationMinCooccurrence` sources is scored with Dunning's G² and PMI. Pairs need G² ≥ `associationMinG2`, and only the top `associationTopK` edges per entity are kept.
   - **Claims.** A kept pair becomes a symmetric `ASSOCIATED_WITH` claim with id `association:<a>:<b>`. Its strength and confidence are `1 − exp(−G²/40)`, and its qualifiers are `{g2, pmi, cooccurrences}`. Edges that fall below the thresholds are retracted.
   - **Grounding.** Each edge cites up to five of the sources it was counted in, so a restricted profile sees it only if it can see one of them.
   - **Search.** Search expansion follows these edges like any other proposed link: only those with confidence ≥ 0.6.
2. **Rules** (`lib/graph/rules.ts`, method `rule:<id>`). A stratified, semi-naive Datalog evaluator runs over claims mapped onto the typed schema, between canonical identities. Each conclusion lists its premises in `dependsOn`, so retracting a premise makes the conclusion stale.
   - `applied-offered`: APPLIED_TO(x, o) ∧ OFFERED_BY(o, org) ⇒ INTERACTED_WITH(x, org).
   - `part-of-transitive`: PART_OF closure between things. Connector containers have their own structural PART_OF and are not closed over.
   - `email-domain-affiliation`: a person writing from an organization's own mail domain ⇒ AFFILIATED_WITH, once at least two people share the domain.
     - The address must be personal: not free mail, not a role mailbox, and its display name must read as a person's.
     - The domain must name the organization: an abbreviation of its name ("uwaterloo.ca" for University of Waterloo, "nyas.org" for the New York Academy of Sciences), or a domain key on exactly one organization.
     - People with a stated WORKS_AT, STUDIES_AT, or MEMBER_OF for that organization are skipped.
   - **Functional conflicts.** Two live claims of a functional predicate (a deadline, a start or end date, OFFERED_BY) can name different targets for the same one-off subject (an opportunity, event, course, or project). When they share a facet, overlap in validity, and come from different sources, they are linked as `contradicts`, which `GraphConflicts.find` reports. Nothing is retracted.
3. **Surface patterns** (`lib/graph/patterns.ts`, method `pattern`). Seeds are the model's typed relation claims whose evidence quote names both entities.
   - **Learning.** The words between the two names, and one word either side, are generalised into token patterns. Addresses, links, and numbers are masked.
   - **Selection.** A pattern is kept when at least `patternMinSupport` distinct pairs support it and its precision on held-out folds is at least `patternMinPrecision`. Folds are split by source, and each pattern is tested on the full passages with gazetteer mentions.
   - **Storage.** Learned patterns are stored in `extension_state` (`relation-patterns-v1`) and relearned at most daily.
   - **Applying.** Each run applies them to up to `patternSourcesPerRun` newly digested sources. Each claim quotes the exact span covering both mentions.

```bash
bun run settings set knowledge-graph reasoningMode active
```

## Search index

The `search-indexer` cron (every five minutes, and a few seconds after `source:ingested`) maintains the fielded source index in `sdk/retrieval/indexer.ts`.
- **Fields.** `source_search_fts` has one row per source, with columns `title`, `entities`, `keyphrases`, `summary`, `body` weighted by `bm25()`. `source_search_trigram` covers title + entities for partial words and typos.
  - `entities`: names, aliases, and acronyms of linked registry entities across their canonical groups. Self, episodes, sessions, pages, and connector events are excluded.
  - `summary`: the summary without its extractive "Coverage:" overview.
  - `body`: retained snippets without producer boilerplate. A line is boilerplate when it appears in more than 30% of one sender's (or host's) sources, given at least five, or is constant text of an email template.
- **Incremental.** A source is rebuilt when it is new, its memory version changes, or its entity stamp changes. The stamp covers linked groups, entity versions, access labels, and title. Documents of removed sources are deleted.
- **Access.** Every query joins `search_docs` → `sources`. See [access control](../../docs/access-control.md).
- **Settings.** `searchIndexEnabled` (default true), `searchIndexBatch` (sources per run, default 500).

## Search ranking

`search_graph` ranks sources with plain BM25 (`searchRanker: "bm25"`, the default) or with the ranking engine in `sdk/retrieval/` (`searchRanker: "engine"`, or `ranker: "engine"` per call). The engine falls back to BM25 until the index above is built.
- **Query understanding** (`query.ts`). Quoted phrases; `from:`, `origin:`, `type:`, `source:`, `before:`, `after:` operators; relative dates ("last week", "in June"); deadline wording ("deadline", "due", "upcoming"); registry entities by name or acronym, expanded to their other names; spelling correction for words the index has not seen; IDF weights, with very common words optional.
- **Candidates and features** (`engine.ts`, `features.ts`). BM25F with relaxation (all terms, then all but the least informative, then any), entity-linked sources and members of episodes involving them, trigram titles for typos, and pseudo-relevance feedback when almost nothing matches. Features: BM25F, IDF-weighted coverage, proximity in the best passage, phrase and title match, entity match, graph proximity (2-hop personalised PageRank over source, episode, and `ASSOCIATED_WITH` links), recency by source type, upcoming dates for deadline wording, involvement, and quality and bulk penalties.
- **Results page** (`collapse.ts`). One hit per email thread, email template, SimHash near-duplicate cluster, or identical title, with the others under `similar`. MMR over the top 30 keeps one topic from taking every slot. Each hit's preview is the passage with the tightest window of query words.
- **Weights.** Code defaults (tuned), then tuned weights in `extension_state` (`knowledge-graph`/`search-weights`), then the `searchWeights` setting. `bun scripts/search-tune.ts <copy.db>` tunes them by coordinate ascent on synthetic known-item queries plus half of the judged queries, and reports the held-out half; `--save` writes only to a scratch copy. Evaluate with `bun scripts/search-eval.ts <db> --ranker engine`.
- **Explain.** `explain: true` on `search_graph` returns each hit's per-feature contributions.

Use [the graph SDK reference](../../sdk/graph/README.md) for the full channel catalog and data semantics. Handler failures propagate through the message bus; ambiguous name-based linking returns an explicit error. Reciprocal links use declared inverse or symmetric relations.
