# Shale monitoring report — 2026-10-13

The ownership/debugging work continues. The worktree has been reviewed, corrected, tested, and loaded into the daemon. This report records progress and remaining work; it does not claim that the populated graph is complete.

At 09:15 UTC, `/health` returned `ok`, the host reported `running`, and MCP was available on port 7427. Current daemon output is in `data/logs/monitor-20261013-continued.log`. The current tool session is 69760; revalidate it or the live endpoints before acting on this information.

The initial worktree adds source digests, typed entity descriptions and registry matching, identity resolution, episode assignment/consolidation, permission-scoped episode reads, and a real-data graph evaluation. It also adds YouTube capture, Discord relevance filtering and bounded REST ingestion, email cursor recovery, and live graph UI updates. These move the project toward connected knowledge rather than isolated connector records. The populated database exposed failures not covered by the original passing suite.

| Measurement | Initial snapshot | 09:15 UTC snapshot |
| --- | ---: | ---: |
| Sources | 2,806 | 2,959 |
| Digestible sources reported by evaluation | 2,488 | 2,641 |
| Source digests | 45 | 96 |
| Entities seen in multiple origins | 3 | 12 |
| Active identity merges | 86 | 443 |
| Pending identity pairs | 73 | 0 |
| Episodes | 1 | 5 |
| Episodes spanning multiple origins | 0 | 1 |

A follow-up recovery through the reloaded host committed nine more saved windows: the digest count reached **105** and the checkpoint queue was empty at that check. The extractor's next model batch remained running. This is a later observation than the comparison table above.

A cross-source episode evaluation passed using normal extraction and model-reviewed consolidation, without forcing episode membership.

Corrections made during this pass:

- Independent extensions start concurrently; jobs within one extension retain their startup order.
- Truncated classifier text iterators use dedicated, finalized SQLite statements. Verbose reasons are bounded without discarding valid tiers, output space scales with record count, and rejected model bodies are kept out of warnings. A live run refined 20 sources with zero failures.
- Later extraction windows reopen episode assignment. Focused extraction can reproduce individual source failures through the normal lease, validation, and checkpoints.
- Connector-known absence of the user suppresses personal activities. Observer activities cannot create episode aliases; unsupported aliases can be removed through the scoped, audited mutation API.
- Recurring organizations/projects/courses/opportunities can enter model review before a second story is started. Unmatched context is reconsidered after related episode evidence changes; ubiquitous entities do not reopen decisions.
- Consolidation compares canonical identities, considers specific shared pursuit entities, and reconsiders declined pairs after evidence changes. Evaluation follows complete merge chains.
- Episode assignment, source ingestion, and chat-window commit reserve the SQLite writer before reads. Real second-process regression tests reproduce contention and verify successful waiting and checkpoint recovery. The failed email window was committed, its attempts reset to zero, and email checkpoints cleared without another model call.
- The retired source-linker recovery respects `enabled: false`, preserving checkpoints until explicit re-enabling.
- The audit uses original-source fingerprints to distinguish retained-memory edits from genuine stale support.
- An entity relationship carrying a literal datatype blocked recovery of twelve extraction windows. Parsing and checkpoint commit now share datatype normalization; all twelve saved windows committed without another model call. Extraction commit also reserves the writer before reads.
- Host recovery no longer reserves the GPU before acquiring extension leases. A contention regression reproduces the old lock-order failure and passes with the fix; model calls and model batches retain their SDK scheduling.
- Removing a source deletes `source_entities` through the memory cleanup trigger. Episode visibility now also checks durable active membership claims across complete merge groups, preventing an episode narrative becoming visible after a hidden/archived member disappears. Archive/restore and merged-member regressions pass.
- Heuristic source/revision classification reserves the writer before reading. Truncated source iterators are finalized. A populated restricted-profile probe initially failed with `SQLITE_BUSY`; it succeeds after this correction. Reverse provenance indexes reduced observed opening time from about 39 seconds to about 8 seconds with the same visible source/entity/claim/chunk/evidence counts. Initialization can reuse an unchanged first visibility snapshot; concurrent daemon writes can still require a second snapshot.
- The live email importer indexed another 37 windows with no errors. Two further live classifier runs each refined 20 sources with zero failures.

Validation on the final code:

- Full Bun suite: **785 passed, 9 optional browser tests skipped, zero failures** (794 tests, 115 files).
- Those optional tests were run separately: **7 web UI checks and 2 real Chrome extension checks passed**. Coverage includes live graph updates, 5,000 nodes/10,000 links, offline Chrome recovery, and YouTube playback/worker restart.
- Typechecking, browser bundle freshness, web build, and `git diff --check` passed.
- The reloaded daemon reported no failed startup jobs at the final health poll; several model jobs remained live. This does not prove their eventual success.

The integrity/provenance audit remains red for **14 claims without source evidence**: five earlier analysis claims and nine legacy source-linker proposals. The snapshot reports no integrity, foreign-key, quote, missing-chunk, missing-model, unreviewed accepted-model, or stale-support failures. These fourteen records require evidence review or audited correction; they were not hidden by relaxing the audit.

Remaining work:

1. Continue monitoring the live recovery/extraction/classifier runs and the substantial undigested backlog. Checkpoint counts and progress must be read fresh.
2. Resolve the fourteen unsupported claims without fabricating citations.
3. Investigate four directory screenshot requests that exceeded 120 seconds. The timeout covers the routed request and HTTP model call; same-resource nested model reservations reuse the outer reservation. A read-only single-image diagnostic on a 2,512×1,158 screenshot did not finish; backend snapshots showed the same request processing with zero decoded tokens. The diagnostic was stopped after more than two minutes and made no graph commit. It used the direct SDK description path, whose HTTP timeout permits retries, so it does not measure the routed request deadline. The backend uses CPU image projection (`--no-mmproj-offload`); queue delay versus projection/generation latency still requires controlled measurement. No image quality or timeout setting was changed.
4. Improve coverage and evaluate more real pursuits, across multiple cross-source threads.
5. Correct episode merge undo and assess summary provenance after explicit detachment. Merge copies membership/involvement bookkeeping which generic entity unmerge does not reverse. Source archival visibility has been corrected and tested; detachment removes and retracts membership while retaining the previously generated narrative until consolidation, so its content provenance still needs work.

Useful commands:

```bash
bun scripts/audit-graph.ts
bun scripts/graph-eval.ts --json
bun scripts/digest-sources.ts <source-id> [source-id ...]
bun extensions/knowledge-extractor/repair-digests.ts
```

Controlled reloads confirmed the old daemon and graph worker had exited before reclaiming only their captured lease tokens. The replacement daemon resumed durable work with startup backups. Continue using live process/session evidence before reclaiming ownership; a lease row or observation timeout alone is insufficient.
