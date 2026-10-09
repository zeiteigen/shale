# Image processor

The `file:process` and `files:process` handlers perform vision analysis and return contextual text chunks for the caller to store.

Responses include URI-based `identityKey` values, local asset fingerprints, and portable `knowledge` claims with predicates, chunk indexes, proposal status, method, and model when available. `VISUAL_LAYOUT` and `VISUAL_MEANING` are interpretations; both description chunks are synthetic. Disabling `describeImages` produces placeholders with the `fallback` method. When descriptions are enabled, failed or empty vision responses return failed items so connectors can retry instead of indexing an unavailable description as successful. Context edges default to the directed `CONTAINED_IN` relationship.

This service prepares data; the consuming connector owns persistence. After saving the response chunks, use `SourceGraph` and `commitPreparedClaims` to bind assertions to that source revision. Shift claim chunk indexes when appending descriptions to another source. Keep the source write, graph commit, and checkpoint completion in one database transaction.

The standalone image analysis implementation lives in `sdk/media/image.ts`; extensions communicate through the typed message bus and do not import each other's implementations.
