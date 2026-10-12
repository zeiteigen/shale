# Access control

Access profiles decide which of your data each consumer of the knowledge graph can use. The MCP server applies them today; any other application can use `createScopedSDK` (`sdk/access.ts`) to get the same view.

## Tiers

Every source, entity, and claim has a sensitivity tier:

| Tier | Meant for |
| --- | --- |
| `public` | Published or widely known information |
| `personal` | Your ordinary notes, work, interests, and acquaintances |
| `private` | Health, finances, legal matters, relationships, private messages, contact details |
| `secret` | Credentials, API keys, card and account numbers, government IDs |

A profile with clearance `personal` sees `public` and `personal` records.

### How a record gets its tier

Labels are stored in `graph_access_labels`, one row per classifier:

- **heuristic** (`lib/access/heuristics.ts`) covers:
  - credentials, private keys and tokens, card numbers that pass a Luhn check, IBANs, SSNs, and identity document numbers;
  - email addresses, phone numbers, street addresses, and dates of birth;
  - health, finance, legal, and intimate vocabulary;
  - webmail, banking, and patient-portal URLs, and direct-message sources.

  Credential and account-number findings are **hard**. The heuristic pass runs before a restricted profile reads, so new data is classified before anyone sees it.
- **llm** comes from the `access-classifier` extension (cron, every 30 minutes and on startup). It sends each source, together with the entities and claims grounded in it, to the chat model. For entities and claims it keeps the most sensitive verdict it has seen.
- **manual** labels are tiers you set on the **Access** page or in a record's reader pane.

The effective tier is:

```
manual ?? max(floor, llm ?? heuristic, hard heuristic)
```

- **Floor** is the configured minimum for sources: the first matching `tierRules` entry, then `originTiers[origin]`, then `defaultTier`. Automatic classification can only raise a tier above the floor.
- **The LLM** may lower a soft heuristic finding, such as a business phone number, but never a hard one.
- **Your manual label** always wins.
- **Unclassified records** count as `secret`: a record that no classifier has judged for its current content is hidden from restricted profiles until it is classified. Automatic labels are tied to a content hash, so a changed source is classified again.

Source classification fingerprints include the title, URI, origin, and type as well as the content hash, so metadata-only edits invalidate automatic verdicts. Removed snapshots are classified too. Entity classification uses the displayed name and type. Retained revisions have separate heuristic labels in `graph_access_revision_labels`; replacing sensitive content with benign text does not lower the tier of the old text. Adding or changing retained passages invalidates their revision's label. A source's manual label applies to its history too. A model verdict applies only to the revision and metadata it judged.

## Visibility rules

| Record | Visible when |
| --- | --- |
| Source | Its tier ≤ the profile's clearance, it matches the profile's `allow` list (if any), and it matches no `deny` entry. |
| Chunk, snippet, memory, observation, metadata | Its source and active revision are visible. |
| Revision, passage | Its source is visible, its retained content passes the tier check, and its historical URI passes the profile's source rules. |
| Evidence | Its source revision is visible and its claim is visible. |
| Entity | Its own tier passes, and either it appears in a visible source (`source_entities`, `chunk_entities`, or a claim with evidence in a visible revision) or it has no source provenance at all. |
| Claim | Its own tier passes, its subject and object are visible, it has visible evidence or no evidence at all, and every claim it depends on is visible. |
| Aliases, events, participants, links, reviews, edges | The records they connect are visible. |
| Audit history (`graph_changes`) | The change was made by this profile. Before/after snapshots are removed. |

Restricted profiles see no rows in any other table, including extension state, checkpoints, and any table an extension adds.

## Profiles and tokens

`data/access.json` is created with defaults on first use and read fresh on every request:

```json
{
  "defaultTier": "personal",
  "unauthenticatedProfile": "local",
  "originTiers": { "discord": "private", "instagram": "private", "email": "private" },
  "tierRules": [{ "match": { "uri": "*bank*" }, "tier": "secret" }],
  "profiles": {
    "local": { "clearance": "secret", "write": true },
    "cloud": { "clearance": "personal", "deny": [{ "origin": "browser" }], "write": true }
  }
}
```

- **Rule patterns** use SQLite `GLOB` syntax, which is case-sensitive and uses `*` and `?`, matched against the source's `origin`, `type`, and `uri`.
- **Tokens** are created on the Access page (`POST /api/access/tokens`). Only their SHA-256 hashes are stored, in `data/credentials.json`. Clients send `Authorization: Bearer <token>`.
- **Requests without a token** use `unauthenticatedProfile`. Set it to `null` to require a token.
- **A session stays bound to the profile that opened it.** A request with a different token is rejected. If an edit changes whether a profile is filtered, its existing sessions must reconnect.
- **`bun run mcp --profile cloud`** starts a listener that serves only that profile, without tokens.
- **Browser requests** must use the listener's own origin. Foreign origins and cross-site requests are rejected on both the direct MCP listener and the host gateway. Command-line MCP clients can connect without an `Origin` header.

## How it is enforced

`lib/access/scoped-database.ts` opens a separate connection to the same database file for each restricted profile:

1. It materializes the visible ids into TEMP tables.
2. It creates a TEMP view with the same name as every table and view in `main`. Unqualified SQL resolves `temp` before `main`, so every reader built on this connection is filtered. That includes the MCP tools, the resources, `sdk.memory`, `sdk.search`, `sdk.graph`, and code written later.
3. Tables without a filter rule get an empty view, so access is denied by default.
4. The connection runs with `PRAGMA query_only`.

Visibility is recomputed when the database changes (detected with `PRAGMA data_version`) or the policy changes. The cost grows with the size of the graph.

Two kinds of objects are deliberately not shadowed:
- `chunks_fts`, because FTS5 `MATCH` cannot run through a view. Every query against it joins `chunks`, whose view removes hidden rows, and a test enforces this.
- The FTS storage tables, whose names are reserved.

Neither contains anything the filtered join exposes.

### Writes from restricted profiles

Writes run on the shared connection inside the knowledge editor's transaction (`lib/access/write-guard.ts`):

1. **Before the write,** every record the tool or operation references must be visible (see `WRITE_REFERENCES`). Entity names are resolved only among visible entities. Hidden records are reported as *not found*. A tool or operation that is missing from the map is refused.
2. **Inside the transaction,** the touched records are classified, and visibility is recomputed against the uncommitted state. The change rolls back if it touched a record that was not visible, or if it created a record the profile cannot see. One example is a claim containing a password. Dependent claims elsewhere becoming `stale` is allowed.
3. **Receipts** list only visible records and omit before/after snapshots. Nested evidence, claim links, dependents, merges, and participants are filtered too. Previews use visibility inside their temporary transaction; replayed receipts use current visibility. The actor is recorded as `profile:<name>/<actor>`.

Profiles with `"write": false` do not get any editing tools, including profiles with secret clearance. Revoking write permission also blocks writes from existing sessions.

Known limits:
- `infer_transitive` fails when a derivation would depend on a hidden claim.
- A rejected write can reveal that some out-of-scope record is involved, but never what that record is.
