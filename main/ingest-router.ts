import ingestQueue from "./ingest-queue";
import { IngestMaterial } from "../lib/ingest.types";
import { subscribe_ingest, IngestHook } from "./load-extensions";

const router: Record<string, IngestHook> = {};

(function createRouter() {
  for (const p of subscribe_ingest) {
    if (p.reciever_name in router) {
      console.warn("Multiple parsers have the same name, which is not allowed");
      continue;
    }
    router[p.reciever_name] = p;
  }
})();

async function ingestRouter(item: IngestMaterial) {
  if (item.target_processor in router) {
    router[item.target_processor].func(item);
  } else {
    console.warn(
      "Item from",
      item.metadata.data_origin,
      "doesn't have a subscriber!",
    );
  }
}

ingestQueue.addHandler(ingestRouter);
