# Obsidian connector

Vault ingestion completes note expansion and image analysis before embedding. Each prepared file keeps its parsed metadata, link resolutions, provenance, and namespace in a checkpoint. Source chunks, graph assertions, and checkpoint completion commit together. A failed file retains its checkpoint and prevents the discovery batch from advancing its watermark.

Notes, images, and vaults have identities derived from their absolute URI and namespace. Equal titles do not merge files or vaults. Wikilinks resolve against a single discovery index; ambiguous or missing targets remain scoped `NoteReference` nodes. Authored aliases, heading anchors, link order, and raw link text are retained. Image references use the same index and remain `ImageReference` nodes when unresolved.

The connector writes accepted `IN_VAULT`, `REFERENCES`, `FEATURES_IMAGE`, and `HAS_TAG` claims with source revision evidence. YAML frontmatter retains typed booleans, numbers, arrays, and nested objects as `PROPERTY:<key>` claims. Frontmatter is also saved verbatim for evidence. Aliases are scoped to the vault URI.

Expanded note context and vision descriptions become proposed claims. Both vision chunks are synthetic. Local image SHA-256 fingerprints participate in source revision identity, so changed image bytes invalidate earlier interpretations even when their description is unchanged.

Direct `ingestFile` and `ingestImageFile` calls use the same commit path as vault ingestion and recovery. Their returned title-based `entities` and `edges`, and `commitVaultGraph`, are legacy compatibility helpers; ingestion already commits the authoritative graph.

Existing files receive these records on their next ingestion. Run the Obsidian cron with `forceAll` enabled to refresh unchanged files; return it to false afterward. Existing title-based nodes are preserved for manual identity review rather than automatically merged with path-based nodes.
