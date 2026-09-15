import ingestQueue from "./ingest-queue";
import { IngestMaterial } from "../lib/ingest.types";
import { subscribe_ingest } from "./load-extensions";

async function ingestRouter(item: IngestMaterial) {
  const hook = subscribe_ingest.find(
    (p) => p.reciever_name === item.target_processor,
  );

  if (hook) {
    try {
      await hook.func(item);
    } catch (err: any) {
      console.error(
        `Error executing subscriber hook for "${item.target_processor}":`,
        err?.message || err,
      );
    }
  } else {
    console.warn(
      `Item from ${item.metadata.data_origin} doesn't have a subscriber for target "${item.target_processor}"! Loaded subscribers: [${subscribe_ingest.map((p) => p.reciever_name).join(", ")}]`,
    );
  }
}

ingestQueue.addHandler(ingestRouter);

export default ingestRouter;
