# Historical implementation plans

These documents preserve audit findings, design alternatives and rollout criteria. They are not the current architecture or API specification. Start with [the repository context](../README.md) for current behavior.

| Plan | Status and current reference |
| --- | --- |
| [Browser connector implementation](browser-connector-implementation-plan.md) | Initial 2026-10-01 design/review. Durable browser ingestion was implemented and later modularized. Use [the browser extension README](../../extensions/browser/README.md), [Chrome runtime guide](../../scripts/browser-chrome-extension/README.md) and [architecture](../architecture.md). |
| [Content storage and MCP redesign](content-storage-and-mcp-plan.md) | 2026-10-11 audit/design behind retained source memory. Use [source memory](../source-memory.md) for shipped contracts and [roadmap](../roadmap.md) for dreaming/usage analytics, which remain future work. |

Measurements and test totals in these plans describe their dated snapshots. Revalidate live databases and current tests before relying on them operationally.
