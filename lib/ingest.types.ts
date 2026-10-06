
export interface IngestMaterial {
    target_processor: string
    content: string
    metadata: {
        connector: string,
        data_origin: string,
        time?: number
        
    }

}

export function isIngestMaterial(item: any): item is IngestMaterial {
    return (
        typeof item === "object" &&
        item !== null &&
        typeof item.target_processor === "string" &&
        typeof item.content === "string" &&
        typeof item.metadata === "object" &&
        item.metadata !== null &&
        typeof item.metadata.connector === "string" &&
        typeof item.metadata.data_origin === "string" &&
        (item.metadata.time === undefined || (typeof item.metadata.time === "number" && Number.isSafeInteger(item.metadata.time) && item.metadata.time >= 0))
    )
}