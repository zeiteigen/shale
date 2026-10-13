# Understanding Shale

This is the repository context for contributors and agents. Last checked against the implementation on **2026-10-13**. Start here; extension READMEs describe individual connectors, and `AGENTS.md` contains contributor rules.

## Goal

Shale is a local personal knowledge workspace. It turns notes, files, browsing, conversations, mail, and watched videos into selected source memories, evidence-backed graph assertions, and stories that connect activity across sources. Agents can retrieve that context and make audited corrections through MCP; the local web interface provides configuration, account connections, job controls, and graph inspection.

The useful unit is a connected fact or pursuit with recoverable provenance: an application can span a Discord announcement, a repository visit, and an interview email. Connector records establish what was observed; model extraction proposes what it means. Those two kinds of assertions remain distinguishable.

Shale deliberately retains summaries and selected snippets rather than every original document. It is a selective memory, with bounded retention and explicit gaps. A source URI does not guarantee that omitted details can be recovered later. Connector-private archives can retain bounded raw input for operational recovery; they are excluded from agent retrieval.

## Reading order

| Read | What it establishes |
| --- | --- |
| [Architecture](architecture.md) | Runtime boundaries, startup, ingestion, model scheduling, recovery, and consumers |
| [Code map](code-map.md) | Where to inspect and change each responsibility |
| [Data model](data-model.md) | Sources, retained text, claims, evidence, identities, digests, and episodes |
| [Knowledge pipeline](knowledge-pipeline.md) | How observations become cross-source knowledge; how to diagnose missing connections |
| [Connectors and extension development](extensions.md) | Live extension catalog, manifest contracts, shared chat and Chrome runtimes |
| [Development and operations](development.md) | Setup, configuration, isolation, testing, maintenance, and debugging |
| [Source memory](source-memory.md) | Detailed storage limits, edit/refresh contracts, and migration history |
| [Access control](access-control.md) | Sensitivity tiers, profiles, SQL visibility, and guarded writes |
| [Knowledge editing](knowledge-editing.md) | MCP contracts, audit/version rules, preview/apply, and source removal |
| [Roadmap](roadmap.md) | Implemented capabilities and explicitly future work |

For a code change, read the relevant guide, inspect its linked implementation, then read the affected extension's manifest, settings schema, and tests. Documentation supplies context; executable contracts and current tests settle implementation questions.

## Constraints to preserve

- Local SQLite is the durable store. Keep transactions short; perform remote/model work outside database transactions and checkpoint prepared results before committing them.
- Settings are read fresh. Do not introduce persistent settings caches. Extension state and watermarks belong in `sdk.state`, rather than process globals.
- Cross-extension calls use the typed message bus. Shared algorithms belong in `sdk/` or `lib/`; extensions should not import each other's internals.
- Model assertions carry status, model/method, and evidence. Proposed claims are useful retrieval signals, but are not accepted facts.
- Agent/application consumers use an access profile through `createScopedSDK`. New tables and write operations require explicit visibility and write-guard consideration.
- Recovery must not advance progress beyond a failed commit. Admission receipts, indexing completion, and complete historical coverage are different states.
- Prefer small files with one or two responsibilities. Keep service-specific logic in the owning extension rather than the host or shared browser shell.

## Status versus history

The guides above describe the current implementation. [Plans](plans/README.md), the production cutover section in the source-memory guide, and dated reports under `resources/` preserve historical observations; their counts, process/session IDs, settings, and outstanding issues are not current runtime state. Tests validate isolated fixtures, not the completeness of the user's populated graph.
