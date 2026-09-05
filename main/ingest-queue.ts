import QueueManager from "../lib/queue";
import { IngestMaterial } from "../lib/ingest.types";

const ingestQueue = new QueueManager<IngestMaterial>()

export default ingestQueue