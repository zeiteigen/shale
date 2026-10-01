# Image processor

The `file:process` and `files:process` handlers perform all vision work before any embedding requests. Set `options.deferEmbedding` to true when preparing a larger connector batch.

Responses include URI-based `identityKey` values, local asset fingerprints, and portable `knowledge` claims with predicates, chunk indexes, proposal status, method, and model when available. `VISUAL_LAYOUT` and `VISUAL_MEANING` are interpretations; both description chunks are synthetic. Offline placeholders carry the `fallback` method. Context edges default to the directed `CONTAINED_IN` relationship.

This service prepares data; the consuming connector owns persistence. After saving the response chunks, use `SourceGraph` and `commitPreparedClaims` to bind assertions to that source revision. Shift claim chunk indexes when appending descriptions to another source. Keep the source write, graph commit, and checkpoint completion in one database transaction.

The standalone image analysis implementation lives in `sdk/media/image.ts`; extensions communicate through the typed message bus and do not import each other's implementations.
