# Development and operations

## Run the workspace

```sh
bun run setup
bun run start
```

`setup.ts` installs root and visualizer dependencies, then extension installers. `bun run setup <extension>...` runs selected installers. `start` builds the UI before starting the Bun daemon. Open `http://localhost:7425` for Overview/jobs, Settings, Accounts, Access, Knowledge and Episodes. [`visualizer/README.md`](../visualizer/README.md) covers frontend development and compatibility launchers.

For frontend development, `bun run --cwd visualizer dev` runs the daemon and Vite. For an already built UI, `bun main/index.ts` starts the daemon directly. Add `--cli` to enable the terminal console. Use Overview's command console or terminal `cron list`, `cron run <name>`, and settings commands for manual work.

## Configuration and runtime paths

| Setting or path | Behavior |
| --- | --- |
| `resources/settings.json`, `resources/settings.help.json` | Version-controlled host settings and validation schema |
| `extensions/<name>/settings.json`, `settings.help.json` | Per-extension active settings/schema; read fresh on calls |
| `SHALE_DB_PATH` | Environment override for the database; otherwise root setting, then `data/production.db` |
| `SHALE_SETTINGS_PATH` | Alternate root settings file, useful for isolation |
| `SHALE_ACCESS_PATH` | Alternate access policy; default `resources/access.json` |
| `SHALE_CREDENTIALS_PATH` | Alternate credential file; default `data/credentials.json`, mode 0600 |
| `data/.env` | Startup-loaded model/API secrets, without overriding existing environment; template `resources/.env.example` |
| `PORT` | Web/ingestion listener, default `7425` |
| `SHALE_MCP_PORT` / `MCP_PORT` | Daemon's dedicated MCP port, default `7427` |
| `data/` | Gitignored database, backups, raw imports, sidecars, logs and other private operational data |

Changing settings affects subsequent reads; database/listener construction and startup-loaded environment require a restart. Already prepared checkpoints can still reflect the settings used during preparation; workflows must validate freshness/policy before commit when relevant.

```sh
bun run settings list-extensions
bun run settings list discord
bun run settings describe discord relevanceThreshold
bun run settings set discord relevanceThreshold 0.8
```

Model options resolve explicit request values, SDK configuration, then root settings/environment fallback. Chat and vision can use different endpoints/models. Concurrency, batch size, deadlines/retries and local resource scheduling are described in [`sdk/MODELS.md`](../sdk/MODELS.md). Do not copy credentials into committed settings or diagnostic logs.

## Validate changes

```sh
bun test
bun run typecheck
bun run browser:check
bun run web:build
git diff --check
```

The Bun preload in [`tests/setup.ts`](../tests/setup.ts) redirects the ambient database, host settings, credentials, policy and backup output into temporary directories. Test factories create additional isolated databases/hosts; model and service behavior is mocked where appropriate. Preserve this isolation when adding tests. Importing the normal SDK/host outside the preload can initialize the real database and extension hooks.

Run targeted suites during development. `package.json` offers `test:web`, `test:mcp`, `test:browser`, and browser opt-ins. Typecheck covers root, Chrome source, tests, public typing fixtures and visualizer. Generated Chrome bundles are checked during the suite; a stale bundle is a failure.

Real Chromium tests need `/usr/bin/chromium` or `SHALE_CHROMIUM_PATH` and permission to open loopback listeners/start subprocesses. They use temporary browser profiles and controlled fixture pages, not the user's signed-in profile.

```sh
bun run test:web:browser
bun run test:browser:chrome
# Additional opt-ins not included in those script file lists:
SHALE_WEB_E2E=1 bun test tests/graph-updates-ui.test.ts
SHALE_BROWSER_E2E=1 bun test tests/youtube-chrome.integration.test.ts
```

A sandbox `EPERM: listen` is an environment failure, not evidence of an application defect. Rerun with the required local listener capability. Optional skipped browser tests do not count as browser coverage. Fixture success does not prove live provider compatibility, production graph completeness, or model quality.

## Observe and diagnose

Start with `/health`, Overview job state/logs and the owning connector's status. Check receipt completion, checkpoint queue and watermarks separately. A cron can finish its bounded pass while a large backlog remains. Host run/log state is in memory; operational progress lives in SQLite.

For missing knowledge, follow the milestone table in [the pipeline guide](knowledge-pipeline.md). For contention, inspect transaction boundaries and lease/model acquisition order before extending timeouts. Source classification and retained revision labels are content-sensitive; a restricted profile may hide work awaiting classification. For model failures, inspect configured endpoint/model, bounded output validation, request timeout/retry behavior and preserved checkpoints.

Maintenance tools include:

| Command | Effect |
| --- | --- |
| `bun scripts/graph-eval.ts <database> --json` | Read-only cross-source metrics/example-thread evaluation; defaults to the production path when omitted |
| `bun scripts/audit-graph.ts <database>` | Read-only integrity/provenance audit; defaults to the production path when omitted, exits nonzero on issues |
| `bun scripts/digest-sources.ts <source-id>...` | Mutating bounded extraction over selected live sources using normal leases/checkpoints |
| `bun extensions/knowledge-extractor/repair-digests.ts` | Mutating repair of cached user activities contradicted by connector participation |
| `bun extensions/discord/reclassify.ts --drain` | Mutating relevance cleanup of stored history within per-batch limits |
| `bun run repair:images` | Dry-run decorative-image repair; `--apply` backs up and mutates |
| `bun scripts/migrate-source-memory.ts --database <copy> --apply --compact --report <report>` | Offline memory migration/compaction; rehearse on a copy |

Do not run collection or repair tools merely to inspect code. They can call remote endpoints/local models and alter current knowledge. Read each script's options and database selection first. Keep user data out of source-control diffs and reports unless explicitly intended.

## Backup and recovery

The db-backup extension uses SQLite hot backup APIs. Copying only the main `.db` while WAL writers are active is not a consistent backup procedure. For invasive offline migration, stop writers, take a consistent rollback backup, rehearse on a copy, and check integrity/foreign keys, citations, retained budgets and consumer behavior. See [source-memory migration](source-memory.md#offline-migration).

Do not delete checkpoints to clear an error without understanding whether they are the only saved model output. A retry should reuse valid preparation or explicitly reject/reprepare stale input. Leases belong to their current owner; verify live process/ownership state before reclaiming one. Dated reports and old session IDs are historical evidence, not proof a job has stopped.

## Keep context current

When changing schema, manifests, retention, retrieval defaults or trust boundaries, update the relevant guide and extension README with the same change. Keep [the docs index](README.md) as the reading path. Move design proposals and dated measurements into clearly labeled history rather than allowing them to become contradictory onboarding instructions.
