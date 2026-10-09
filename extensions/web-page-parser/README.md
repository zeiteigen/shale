# Web page parser

The typed `web:parse` request returns readable text, chunks, contextual summaries, image URLs, and prepared image knowledge. Image descriptions remain synthetic and retain their asset URI, method, model, and evidence chunk indexes. Context summaries identify whether they came from an excerpt or an LLM.

The service uses `file:process` for image analysis and performs no database writes. Browser ingestion persists parser output in its checkpoint, then commits source evidence and prepared claims with its page chunks. `imageKnowledge` indexes refer to `imageChunks`; consumers must offset them when combining these with page chunks.
