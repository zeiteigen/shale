# Source linker

Candidate relationships and entity coreferences are proposed LLM claims with immutable source revision evidence. Canonical candidates are scoped to the compared source pair, and alias mentions to their source; equal names across unrelated pairs stay distinct. Confidence and similarity guide proposal selection; they do not accept assertions or merge identities. Reciprocal claims follow declared inverse or symmetric relation definitions.

`REPRESENTS` claims connect each persistent source node to its connector-owned note, page, image, bookmark, or history record through the shared `source-id` identity alias. This lets traversal continue from cross-source links into the structured connector graph. These identity bindings use accepted source identity evidence, separately from the proposed semantic relationship.

Graph commits, checkpoint resolution, and batch progress are transactional. Recovery reuses saved decisions and evidence without another chat request.
