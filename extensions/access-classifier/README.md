# Access classifier

Assigns sensitivity tiers (`public`, `personal`, `private`, `secret`) to sources, entities, and claims. Access profiles use these tiers to decide what each agent can see; see [docs/access-control.md](../../docs/access-control.md).

Each run (every 30 minutes and on startup) does two things:

1. **Heuristics** for every new or changed record. The heuristic pass looks for credentials, card and account numbers, contact details, addresses, sensitive topics, private web services, and direct messages. Restricted profiles also run it before they read, so this cron is only a backstop.
2. **Model refinement** for up to `maxSourcesPerRun` sources whose current content has no model verdict yet. Each prompt includes the source text (up to `maxContentChars`) and the entities and claims grounded in it.

How the verdicts are applied:
- The model may lower a soft heuristic finding, but never a credential or account-number finding.
- For entities and claims, the most sensitive verdict seen across sources is kept.
- Tiers the user sets on the Access page or in a reader pane override both classifiers.
- A source whose model response fails three times keeps its heuristic tier until its content changes.

**Distilled model** (`distilled.ts`). A softmax model over words, record type, predicate, origins, URI host, and the heuristic tier is trained from the stored LLM labels. It is kept in extension state and refit when labels grow by a tenth. For each kind, a tail bound ε is calibrated on held-out sources, so items it settles rarely have an LLM tier above the recorded one. `distilledMode`:
- `shadow` (default): verdicts are recorded in `graph_shadow_decisions` (kind `access`) beside the LLM's.
- `active`: a source skips the LLM only when the model settles the source and every listed entity and claim. To settle, it must predict at least the heuristic tier with P(LLM more sensitive) ≤ ε. Labels are written with origin `distilled` at max(heuristic, prediction). They count as classified and rank below LLM labels and above heuristics. They are never written over an LLM label.
- `off`: no distilled model.

Settings are read on every run: `enabled`, `llmEnabled`, `maxSourcesPerRun`, `maxContentChars`, `llmModel`, and `distilledMode`.
