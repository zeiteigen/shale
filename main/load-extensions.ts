import { Glob } from "bun";
import { join, dirname } from "node:path";
import {
  isTExtensionManifest,
  type ExtensionManifest,
  CronExtension,
} from "../lib/extension";
import { IngestMaterial } from "../lib/ingest.types";

export type IngestHook = {
  func: (item: IngestMaterial) => Promise<void>;
  reciever_name: string;
};

export const extensionsDir = join(import.meta.dir, "../extensions");
const glob = new Glob("**/manifest.json");

const crons: CronExtension[] = [];
const subscribe_ingest: IngestHook[] = [];
for await (const file of glob.scan(extensionsDir)) {
  try {
    const manifestPath = join(extensionsDir, file);
    const manifestFile = Bun.file(manifestPath);
    const manifest: ExtensionManifest = JSON.parse(await manifestFile.text());

    if (isTExtensionManifest(manifest)) {
      const extensionFolder = dirname(manifestPath);

      if (manifest.subscribe_ingest) {
        const entryPath = join(extensionFolder, manifest.subscribe_ingest);
        const entryModule = await import(entryPath);

        if (
          entryModule &&
          entryModule.subscribe &&
          typeof entryModule.subscribe === "function"
        ) {
          if (entryModule.init && typeof entryModule.init === "function") {
            await entryModule.init();
          }
          subscribe_ingest.push({
            func: entryModule.subscribe,
            reciever_name: manifest.name,
          });
        }
      }
      if (manifest.crons) {
        for (const cron of manifest.crons) {
          cron.script = join(extensionFolder, cron.script);
          cron.extensionId = manifest.name;
          cron.namespace = manifest.namespace || manifest.name;
          crons.push(cron);
        }
      }
    } else {
      console.warn(
        "Manifest file at",
        file,
        "was in the /extensions dir but isn't loaded because we failed to recognize it as a valid ParserManifest. Please check the manifest file for correctness.",
      );
    }
  } catch (err) {
    console.error("Error loading extension from file", file, ":", err);
  }
}

export { crons, subscribe_ingest };
