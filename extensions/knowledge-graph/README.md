# Knowledge graph service

Registers typed message handlers for graph storage, retrieval, evidence inspection, and identity/review correction. It also runs the `identity-resolver` cron, every 15 minutes and at startup.

## Identity resolution

Each run of `identity-resolver` does five things:

1. **Registry.** On the first run, it indexes existing people, organizations, projects, artifacts, and episodes into the registry (`entity_registry_fts`).
2. **Connector keys.** It gives connector entities their identity keys: Discord users and servers, email senders, and visited or shared pages. Shared keys then merge entities of the same family. For example, a link posted in Discord and a visit to that page become one page. Shared keys link entities of different families instead: a page `REFERS_TO` the repository or account it shows, and a Discord server is `COMMUNITY_OF` the organization with the same name.
3. **Self.** It gathers the user's accounts into one `Person` with stable id `self`. The accounts come from the connected Discord account, the connected mailbox, and the `selfNames`, `selfEmails`, and `selfHandles` settings (for example `["github:zeiteigen"]`).
4. **Duplicate sweep.** It queues canonical entities that share a name or acronym key for adjudication.
5. **Adjudication.** It asks the model about queued pairs, eight per request, up to `maxAdjudicationsPerRun`. At 0.85 confidence or more, the pair is merged. Between 0.6 and 0.85, a proposed `COREFERS_TO` is written.

Merges are recorded in `graph_identity_changes` and can be undone (`graph:unmerge`, `unmerge_entities`, or the visualizer).

```bash
bun run settings set knowledge-graph selfHandles '["github:zeiteigen"]'
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

Use [the graph SDK reference](../../sdk/graph/README.md) for the full channel catalog and data semantics. Handler failures propagate through the message bus; ambiguous name-based linking returns an explicit error. Reciprocal links use declared inverse or symmetric relations.
