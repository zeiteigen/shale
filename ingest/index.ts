

import ingestQueue, {isIngestMaterial} from "./ingest-queue"


Bun.serve({
    port: 74253,
    routes: {
        '/ingest': async req => {

            try {
                const body = await req.json()

                if(!isIngestMaterial(body)){
                    return new Response("ERR")
                }

                ingestQueue.add(body)
                return new Response("OK")
            }
            catch(err: any){
                console.log("Err in /ingest:", JSON.stringify(err))
                return new Response("ERR")
            }
        }
    }
})
