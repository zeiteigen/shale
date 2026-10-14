# Episodes

An episode is one of the user's pursuits that spans sources over time: applying to a club, building a project, a job search, planning a trip. For example, "Joining NHPC" covers three sources:

- the onboarding thread on the club's Discord;
- the fork of its onboarding repository on GitHub;
- the interview invitation email.

## Model

- **Entity:** each episode is an `Episode` entity with a `graph_episodes` row (kind, status, summary, dates, step labels).
- **Members:** a member source joins through a `PART_OF_EPISODE` claim from its record entity. Its qualifiers carry the source id, the role (`trigger`, `progress`, `outcome`, `context`), and the step.
- **Involved entities:** `INVOLVES` claims name the people, organizations, and artifacts that characterise the episode.

Read episodes through `sdk/graph/episodes.ts`, the MCP tools `list_episodes`, `get_episode`, and `entity_timeline`, or the web interface's **Episodes** page.

## Assignment (`episodes-assign`, every ten minutes and at startup)

Digested sources (`graph_source_digests`, written by `knowledge-extractor`) are assigned oldest first, so stories grow in order.

**Scoring.** A source's signals are:

- the canonical entities its digest resolved;
- its connector context: the channel and server, pages shared in it, and what those pages refer to.

Candidate episodes are those involving any signal. Each candidate is scored as:

`Σ idf(shared entity) × (0.4 + 0.6 × recency) + 2 if the digest named the episode`

IDF is computed over digested sources, so the user, or a platform that appears everywhere, adds almost nothing. A rare name such as "NHPC" adds a lot.

**Decisions.**

- **Attach:** a clear winner at or above `attachScore` joins directly. Sources the user did not take part in need 1.5 times `attachScore`.
- **Review:** scores at or above `reviewScore` go to a short model review. A shared organization, project, course, or opportunity can enter review at half that score, so a recurring pursuit is considered before a new story starts.
- **New episode:** otherwise, a new episode starts only when the user took part and the digest reported an activity.
- **None:** everything else stays outside episodes.

An unmatched source is reconsidered when a nearby episode gains evidence about the same specific organization,
project, course, or opportunity. Ubiquitous entities do not reopen decisions. Membership, involved entities, and
the digest's assignment state commit together, with the SQLite writer reserved before membership reads.

## Consolidation (`episodes-consolidate`, nightly)

- **Rewrite:** changed episodes get a fresh title, summary, step labels, and status (`closed` once finished) from their members.
- **Merge:** open episodes overlapping in time are reviewed when they share two involved entities, or one organization, project, course, or opportunity. Entity aliases merged into a canonical identity count together. A merge still requires model confidence of at least 0.8. A declined pair is reconsidered after its members or summaries change.
- **Dormancy:** episodes idle for `dormantDays` become dormant until a new member arrives.

## Corrections and access

- **Corrections:** `merge_episodes`, `split_episode`, and `detach_from_episode` are audited and pass the access write guard. Merges group identities without copying memberships or involvement claims; `unmerge_entities` separates them again and preserves each original episode's dates and status. Consolidation refreshes generated narratives afterward.
- **Access:** an episode is visible to an access profile only if every member and narrative input source is visible. `graph_episode_provenance` retains narrative inputs through detachment, source removal, and identity changes. A complete title/summary rewrite can replace those inputs; a rewrite is discarded if its episode inputs changed during the model request.

```bash
bun run settings set episodes attachScore 5
```

In the daemon CLI: `cron run episodes-assign`, `cron run episodes-consolidate`.
