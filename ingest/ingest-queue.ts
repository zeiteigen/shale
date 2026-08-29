import QueueManager from "./queue";

interface IngestMaterial {
    origin: string,
    time?: number,
    content: string

}

export function isIngestMaterial(item: any) {
    return (
        typeof item === "object" &&
        item !== null &&
        typeof item.origin === "string" &&
        typeof item.time === "number" &&
        typeof item.content === "string"
    )
}

const ingestQueue = new QueueManager<IngestMaterial>()

export default ingestQueue