# Episodes

An episode is one of the user's pursuits that spans sources over time: applying to a club, building a project, a job search, planning a trip. For example, "Joining NHPC" covers three sources:

- the onboarding thread on the club's Discord;
- the fork of its onboarding repository on GitHub;
- the interview invitation email.

## Model

- **Entity:** each episode is an `Episode` entity with a `graph_episodes` row (kind, status, summary, dates, step labels).
- **Members:** a member source joins through a `PART_OF_EPISODE` claim from its record entity. Its qualifiers carry the source id, the role (`trigger`, `progress`, `outcome`, `context`), and the step.
- **Involved entities:** `INVOLVES` claims name the people, organizations, and artifacts that characterise the episode. They are the hooks new sources are matched on, and they come only from defining members (see below).

Read episodes through `sdk/graph/episodes.ts`, the MCP tools `list_episodes`, `get_episode`, and `entity_timeline`, or the web interface's **Episodes** page.

## Assignment (`episodes-assign`, every ten minutes and at startup)

Digested sources (`graph_source_digests`, written by `knowledge-extractor`) are assigned oldest first, so stories grow in order.

**Scoring.** A source's signals are:

- the canonical entities its digest resolved;
- its connector context: the channel and server, pages shared in it, and what those pages refer to.

Candidate episodes are those involving any signal. Each candidate is scored as:

`Σ idf(shared entity) × (0.4 + 0.6 × recency) + 2 if the digest named the episode + attachScore if the activity label names it`

IDF is computed over digested sources, so the user, or a platform that appears everywhere, adds almost nothing. A rare name such as "NHPC" adds a lot.

**Label match.** A digest's activity label that equals an open episode's title, or an earlier member's label, counts as much as `attachScore`. Labels are compared as whole names, ignoring case and punctuation, within `recencyDays`. Notes digested in bulk often reach assignment before the identity resolver has merged their entities. Each one may then carry its own copy of "Global Politics", but "Global Politics Revision" still joins the episode of that name without the model.

**Decisions.**

- **Attach:** a clear winner at or above `attachScore` joins directly. Sources the user did not take part in need 1.5 times `attachScore`.
- **Review:** scores at or above `reviewScore` go to a model review, six sources per request. A shared organization, project, course, or opportunity can enter review at half that score, so a recurring pursuit is considered before a new story starts. Sources the model does not answer are retried next run.
- **New episode:** otherwise, a new episode starts only when the user took part and the digest reported an activity. If an open episode with that label already exists, the source joins it instead. Starting re-checks this inside the write transaction, so parallel review verdicts cannot create the same story twice.
- **None:** everything else stays outside episodes.

An unmatched source is reconsidered when a nearby episode gains evidence about the same specific organization,
project, course, or opportunity. Ubiquitous entities do not reopen decisions. Membership, involved entities, and
the digest's assignment state commit together, with the SQLite writer reserved before membership reads.

## Defining members and derived involvement

A member *defines* its episode when it is any of:
- the trigger;
- added by a correction;
- a member whose activity label names the episode (its title, a former title, or another defining member's label);
- a source of the user's that the model review accepted (at least 0.8).

Other members join through the episode's hooks but never add to them, and their activity labels are not added as episode names. Without this, one weak match could add Google as a hook, and every Google security alert would follow.

- **Hooks.** These are re-derived from the defining members' signals. With one defining source, they are its eight most specific entities. With more, they are the entities carried by at least 15% of them (at least one), up to 24, plus any entity the title names ("UWHPC" in "UWHPC Onboarding"). The user's own identity is never a hook. Only claims the assigner wrote are changed, and retracted claims are restored if support returns.
- **Pruning.** When an episode gains a defining member, or changes before the nightly consolidation, it is audited:
  - names that came from other pursuits are removed;
  - ordinary members that no longer reach the attach score are detached (audited, reversible) and placed again on their merits.

  Manual and model-confirmed members are never pruned, and an episode with no defining source left is not pruned. The first run after this change audits every open episode once (`involvement-derived-v1`).

## Same-title folding (every assignment run)

Before deciding new sources, each run folds open episodes with the same title (whole-name comparison, any kind) whose dates lie within `recencyDays` of each other into the oldest. No model is involved. Merges are audited and reversible with `unmerge_entities`, and a pair the user separated that way stays separate.

## Consolidation (`episodes-consolidate`, nightly)

- **Rewrite:** changed episodes get a fresh title, summary, step labels, and status (`closed` once finished) from their members. An episode with one source takes its summary and step from that source's digest without a model request.
- **Merge:** after same-title folding, differently titled open episodes overlapping in time are reviewed when they share two involved entities, or one organization, project, course, or opportunity. Entity aliases merged into a canonical identity count together. A merge still requires model confidence of at least 0.8. A declined pair is reconsidered after its members or summaries change.
- **Dormancy:** episodes idle for `dormantDays` become dormant until a new member arrives.

## Global clustering (`clusteringMode`, `narrativeMode`; default `shadow`)

[`lib/graph/cluster.ts`](../../lib/graph/cluster.ts) clusters every digested source at once instead of one at a time:

- **Affinity:** Σ over shared canonical signals of idf × type weight × exp(−|Δt|/`clusterTauDays`). Signals that travel together (a sender's organisation, address, and footer links) count once, and a pair linked by a single piece of evidence counts half.
- **Constraints:** one email thread or chat conversation, one URL, and Obsidian wikilinks (hub notes excepted) are must-links, as are each episode's protected members (manual, model-confirmed, closed). Manual detachments and undone episode merges are cannot-links.
- **Clustering:** constrained Leiden with the Constant Potts Model (resolution `clusterResolution`), then splits at gaps longer than `dormantDays`. A cluster is a pursuit only when the user took part in a source whose digest names an activity. Observer-only clusters attach as context to the nearest pursuit when affinity suffices. Clusters keep existing episode ids through Hungarian matching on member overlap.
- **Narrative:** [`lib/graph/episode-narrative.ts`](../../lib/graph/episode-narrative.ts) derives the kind and stage from per-kind state machines over lexicon cues. It also sets roles and closes an episode when a closing stage (rejected, delivered, completed, …) is the latest member's. The title is the most specific shared entity plus a kind word, unique among open episodes. The summary is a LexRank extract of member digests.

**Shadow** records the clustering's verdict per source (`graph_shadow_decisions`, kind `episode`, subject `source:<id>`), its view of each model merge (`merge:<a>:<b>`), and the deterministic narrative (kind `summary`, subject `episode:<id>`). The model's verdicts are recorded beside them.

**Active** clustering replaces the model review and the model duplicate merge:
- it writes only diffs (merge, attach, move, create) with basis `cluster …` and actor `episodes-cluster`;
- a member moves only when its affinity gain exceeds `clusterHysteresis`, never out of a one-member episode;
- a fresh attachment needs at least two independent shared signals;
- episodes merge only with direct affinity of at least `clusterMergeAffinity`;
- at most `maxClusterChangesPerRun` changes are made per run.

Cluster-placed members are re-judged by the clustering, not by the score audit. Active narrative replaces the model rewrite but keeps the current title unless that title came from members that have left. With `llmNarrativePolish`, the model still rewrites multi-source episodes.

## Corrections and access

- **Corrections:** `merge_episodes`, `split_episode`, and `detach_from_episode` are audited and pass the access write guard. Merges group identities without copying memberships or involvement claims; `unmerge_entities` separates them again and preserves each original episode's dates and status. Consolidation refreshes generated narratives afterward.
- **Access:** an episode is visible to an access profile only if every member and narrative input source is visible. `graph_episode_provenance` retains narrative inputs through detachment, source removal, and identity changes. A complete title/summary rewrite can replace those inputs; a rewrite is discarded if its episode inputs changed during the model request.

```bash
bun run settings set episodes attachScore 5
```

In the daemon CLI: `cron run episodes-assign`, `cron run episodes-consolidate`.
