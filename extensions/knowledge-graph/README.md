# Knowledge graph service

Registers typed message handlers for graph storage, retrieval, evidence inspection, and identity/review correction. It loads automatically through its manifest and does not run background model workloads.

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
