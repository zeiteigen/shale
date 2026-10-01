# Web page parser

The typed `web:parse` request returns readable text, chunks, contextual summaries, image URLs, and prepared image knowledge. Image descriptions remain synthetic and retain their asset URI, method, model, and evidence chunk indexes. Context summaries identify whether they came from an excerpt or an LLM.

The service uses `file:process` with deferred embedding for images. It performs no database writes or embeddings. Browser ingestion persists the parser response in its checkpoint, then commits source evidence and prepared claims during the embedding phase. `imageKnowledge` indexes refer to `imageChunks`; consumers must offset them when combining these with page chunks.
